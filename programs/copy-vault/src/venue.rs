//! Generic pass-through CPI into a whitelisted pump / pump_amm trade instruction
//! (`docs/research/pump-integration.md` §7.3). The keeper forwards the venue instruction's exact
//! account list (remaining accounts) and data; the program
//!
//! 1. matches (program, discriminator) against a config descriptor of the right side,
//! 2. checks the account roles: the trading PDA (vault or burn pool) at `user_idx` and nowhere
//!    else, the traded mint at `base_mint_idx`, the canonical curve / pool PDA of that mint at
//!    `venue_idx` (SOL-quoted, not mayhem), and no writable token account owned by the PDA other
//!    than its token account for the traded mint and its wSOL account,
//! 3. reads the venue reserves for its own fee-free quote, impact and signal maths,
//! 4. signs the CPI as the PDA only (every other meta is forwarded as non-signer), wrapping SOL
//!    into the PDA's wSOL account first and unwrapping it after for pool trades,
//!
//! and the caller measures the fill from balance deltas — never from the venue's own limits.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::associated_token;
use anchor_spl::token::{self, spl_token};
use anchor_spl::token_interface;

use crate::errors::CopierError;
use crate::math;
use crate::pump::{self, BondingCurve, Pool};
use crate::state::{Side, TradeDescriptor, Venue};

/// What the program reads from the venue before trading.
pub struct VenueQuote {
    pub venue: Venue,
    /// The venue account (curve or pool).
    pub venue_key: Pubkey,
    /// Pricing reserves: curve virtual quote / tokens, or pool effective quote (balance + virtual)
    /// / base balance.
    pub quote_reserve: u64,
    pub token_reserve: u64,
    /// Real SOL the venue holds (curve `real_quote_reserves`, pool quote balance): the impact cap.
    pub real_quote: u64,
    /// Most tokens a buy can receive (curve `real_token_reserves`, pool base balance).
    pub max_tokens_out: u64,
}

impl VenueQuote {
    /// Lamports `tokens` are worth at spot.
    pub fn value_of(&self, tokens: u64) -> Result<u64> {
        math::mul_div(tokens, self.quote_reserve, self.token_reserve)
    }

    /// Fee-free tokens out for `sol_in`, capped at what the venue can deliver.
    pub fn buy_quote(&self, sol_in: u64) -> Result<u64> {
        Ok(math::cp_tokens_out(self.quote_reserve, self.token_reserve, sol_in)?.min(self.max_tokens_out))
    }

    /// Fee-free lamports out for `tokens_in`.
    pub fn sell_quote(&self, tokens_in: u64) -> Result<u64> {
        math::cp_quote_out(self.quote_reserve, self.token_reserve, tokens_in)
    }
}

/// The trading PDA and the accounts it trades with.
pub struct Trader<'a, 'info> {
    /// System-owned, zero-data PDA (vault or burn pool): the venue `user`.
    pub actor: &'a AccountInfo<'info>,
    pub actor_seeds: &'a [&'a [u8]],
    pub token_mint: &'a AccountInfo<'info>,
    /// ATA(actor, token_mint, token_program).
    pub actor_tokens: &'a AccountInfo<'info>,
    /// ATA(actor, wSOL, SPL Token).
    pub actor_wsol: &'a AccountInfo<'info>,
    /// Owner program of `token_mint`.
    pub token_program: &'a AccountInfo<'info>,
    /// SPL Token (wSOL).
    pub quote_token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub remaining: &'a [AccountInfo<'info>],
}

impl<'a, 'info> Trader<'a, 'info> {
    /// Checks the canonical addresses of the trader's own token accounts and token programs
    /// (`check_wsol = false` when the caller already checked the wSOL account, e.g. in `sync`).
    pub fn check_accounts(&self, check_wsol: bool) -> Result<()> {
        require_keys_eq!(*self.token_mint.owner, self.token_program.key(), CopierError::MintMismatch);
        require!(pump::is_token_program(self.token_program.key), CopierError::MintMismatch);
        require_keys_eq!(self.quote_token_program.key(), spl_token::ID, CopierError::TokenAccountMismatch);
        require_keys_eq!(
            self.actor_tokens.key(),
            associated_token::get_associated_token_address_with_program_id(
                self.actor.key,
                self.token_mint.key,
                self.token_program.key
            ),
            CopierError::TokenAccountMismatch
        );
        if check_wsol {
            require_keys_eq!(
                self.actor_wsol.key(),
                associated_token::get_associated_token_address(self.actor.key, &pump::WSOL_MINT),
                CopierError::TokenAccountMismatch
            );
        }
        Ok(())
    }

    /// Lamports the actor holds, its canonical wSOL address included (see
    /// `pump::wsol_address_lamports`): closing the account after a pool trade returns all of it.
    pub fn sol_balance(&self) -> u64 {
        self.actor.lamports().saturating_add(pump::wsol_address_lamports(self.actor_wsol))
    }

    pub fn token_balance(&self) -> u64 {
        pump::token_balance(self.actor_tokens)
    }

    /// Validates `desc` / `ix_data` / remaining accounts for a `side` trade of `token_mint` and
    /// reads the venue.
    pub fn inspect(&self, desc: &TradeDescriptor, side: Side, ix_data: &[u8]) -> Result<VenueQuote> {
        let r = self.remaining;
        require!(desc.side == side, CopierError::DescriptorSide);
        require!(ix_data.len() >= 8 && ix_data[..8] == desc.disc, CopierError::DiscriminatorMismatch);
        require!(r.len() >= desc.min_accounts as usize, CopierError::NotEnoughAccounts);
        require!(
            r.iter().any(|a| *a.key == desc.program && a.executable),
            CopierError::VenueProgram
        );

        let user_idx = desc.user_idx as usize;
        require_keys_eq!(r[user_idx].key(), self.actor.key(), CopierError::UserMismatch);
        require!(r[user_idx].is_writable, CopierError::UserMismatch);
        require_keys_eq!(r[desc.base_mint_idx as usize].key(), self.token_mint.key(), CopierError::MintMismatch);

        for (i, a) in r.iter().enumerate() {
            if i == user_idx {
                continue;
            }
            require_keys_neq!(a.key(), self.actor.key(), CopierError::UserElsewhere);
            if a.is_writable && *a.key != self.actor_tokens.key() && *a.key != self.actor_wsol.key() {
                if let Some((_, owner, _)) = pump::token_account_fields(a) {
                    require_keys_neq!(owner, self.actor.key(), CopierError::ForeignVaultTokenAccount);
                }
            }
        }

        let venue_info = &r[desc.venue_idx as usize];
        match desc.venue {
            Venue::Curve => {
                require_keys_eq!(
                    venue_info.key(),
                    pump::bonding_curve_pda(self.token_mint.key),
                    CopierError::VenueMismatch
                );
                let c = BondingCurve::load(venue_info).map_err(|_| error!(CopierError::VenueInvalid))?;
                require!(!c.complete, CopierError::CurveComplete);
                require!(c.is_sol_quoted(), CopierError::NotSolQuoted);
                require!(!c.is_mayhem_mode, CopierError::MayhemCoin);
                require!(c.virtual_token_reserves > 0 && c.virtual_quote_reserves > 0, CopierError::VenueInvalid);
                Ok(VenueQuote {
                    venue: Venue::Curve,
                    venue_key: venue_info.key(),
                    quote_reserve: c.virtual_quote_reserves,
                    token_reserve: c.virtual_token_reserves,
                    real_quote: c.real_quote_reserves,
                    max_tokens_out: c.real_token_reserves,
                })
            }
            Venue::Pool => {
                require_keys_eq!(
                    venue_info.key(),
                    pump::canonical_pool_pda(self.token_mint.key),
                    CopierError::VenueMismatch
                );
                let p = Pool::load(venue_info)?;
                require_keys_eq!(p.base_mint, self.token_mint.key(), CopierError::VenueInvalid);
                require_keys_eq!(p.quote_mint, pump::WSOL_MINT, CopierError::NotSolQuoted);
                require!(!p.is_mayhem_mode, CopierError::MayhemCoin);
                let find = |key: &Pubkey| r.iter().find(|a| a.key == key);
                let base = find(&p.pool_base_token_account).ok_or(CopierError::VenueInvalid)?;
                let quote = find(&p.pool_quote_token_account).ok_or(CopierError::VenueInvalid)?;
                let base_amount = pump::token_balance(base);
                let quote_amount = pump::token_balance(quote);
                let effective = u64::try_from(quote_amount as i128 + p.virtual_quote_reserves)
                    .ok()
                    .filter(|q| *q > 0)
                    .ok_or(CopierError::VenueInvalid)?;
                require!(base_amount > 0, CopierError::VenueInvalid);
                Ok(VenueQuote {
                    venue: Venue::Pool,
                    venue_key: venue_info.key(),
                    quote_reserve: effective,
                    token_reserve: base_amount,
                    real_quote: quote_amount,
                    max_tokens_out: base_amount,
                })
            }
        }
    }

    /// Creates the actor's token account for the traded mint when it does not exist (the actor
    /// pays the rent; the caller books it).
    pub fn ensure_token_account(&self) -> Result<()> {
        if pump::is_token_account(self.actor_tokens) {
            return Ok(());
        }
        associated_token::create_idempotent(CpiContext::new_with_signer(
            self.associated_token_program.clone(),
            associated_token::Create {
                payer: self.actor.clone(),
                associated_token: self.actor_tokens.clone(),
                authority: self.actor.clone(),
                mint: self.token_mint.clone(),
                system_program: self.system_program.clone(),
                token_program: self.token_program.clone(),
            },
            &[self.actor_seeds],
        ))
    }

    fn wsol_mint(&self) -> Result<&'a AccountInfo<'info>> {
        self.remaining
            .iter()
            .find(|a| *a.key == pump::WSOL_MINT)
            .ok_or_else(|| error!(CopierError::VenueInvalid))
    }

    /// Opens the actor's wSOL account (adopting lamports someone sent to the address) and makes it
    /// hold at least `lamports` wrapped: only the shortfall moves from the actor, so lamports already
    /// at the address (counted in `sol_balance`) are spendable too.
    fn open_wsol(&self, lamports: u64) -> Result<()> {
        if !pump::is_token_account(self.actor_wsol) {
            associated_token::create_idempotent(CpiContext::new_with_signer(
                self.associated_token_program.clone(),
                associated_token::Create {
                    payer: self.actor.clone(),
                    associated_token: self.actor_wsol.clone(),
                    authority: self.actor.clone(),
                    mint: self.wsol_mint()?.clone(),
                    system_program: self.system_program.clone(),
                    token_program: self.quote_token_program.clone(),
                },
                &[self.actor_seeds],
            ))?;
        }
        if lamports > 0 {
            let wrapped = pump::token_balance(self.actor_wsol);
            if wrapped < lamports {
                system_program::transfer(
                    CpiContext::new_with_signer(
                        self.system_program.clone(),
                        system_program::Transfer { from: self.actor.clone(), to: self.actor_wsol.clone() },
                        &[self.actor_seeds],
                    ),
                    lamports - wrapped,
                )?;
            }
            token::sync_native(CpiContext::new(
                self.quote_token_program.clone(),
                token::SyncNative { account: self.actor_wsol.clone() },
            ))?;
        }
        Ok(())
    }

    /// Unwraps everything in the actor's wSOL account (rent included) back to the actor.
    fn close_wsol(&self) -> Result<()> {
        token::close_account(CpiContext::new_with_signer(
            self.quote_token_program.clone(),
            token::CloseAccount {
                account: self.actor_wsol.clone(),
                destination: self.actor.clone(),
                authority: self.actor.clone(),
            },
            &[self.actor_seeds],
        ))
    }

    /// The venue CPI: the forwarded accounts with the actor as the only signer.
    fn invoke_venue(&self, desc: &TradeDescriptor, ix_data: Vec<u8>) -> Result<()> {
        let user_idx = desc.user_idx as usize;
        let accounts = self
            .remaining
            .iter()
            .enumerate()
            .map(|(i, a)| AccountMeta { pubkey: *a.key, is_signer: i == user_idx, is_writable: a.is_writable })
            .collect();
        let ix = Instruction { program_id: desc.program, accounts, data: ix_data };
        invoke_signed(&ix, self.remaining, &[self.actor_seeds]).map_err(Into::into)
    }

    /// Executes a buy spending `sol_in` (pool venues: wrapped first, unwrapped after).
    pub fn buy(&self, desc: &TradeDescriptor, sol_in: u64, ix_data: Vec<u8>) -> Result<()> {
        self.ensure_token_account()?;
        match desc.venue {
            Venue::Curve => self.invoke_venue(desc, ix_data),
            Venue::Pool => {
                self.open_wsol(sol_in)?;
                self.invoke_venue(desc, ix_data)?;
                self.close_wsol()
            }
        }
    }

    /// Executes a sell (pool venues: proceeds arrive as wSOL and are unwrapped).
    pub fn sell(&self, desc: &TradeDescriptor, ix_data: Vec<u8>) -> Result<()> {
        match desc.venue {
            Venue::Curve => self.invoke_venue(desc, ix_data),
            Venue::Pool => {
                self.open_wsol(0)?;
                self.invoke_venue(desc, ix_data)?;
                self.close_wsol()
            }
        }
    }

    /// Burns `amount` of the actor's tokens of `token_mint` (Token-2022 `burn_checked`, the actor
    /// signing).
    pub fn burn(&self, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let decimals = {
            let d = self.token_mint.try_borrow_data()?;
            *d.get(44).ok_or(CopierError::MintMismatch)?
        };
        token_interface::burn_checked(
            CpiContext::new_with_signer(
                self.token_program.clone(),
                token_interface::BurnChecked {
                    mint: self.token_mint.clone(),
                    from: self.actor_tokens.clone(),
                    authority: self.actor.clone(),
                },
                &[self.actor_seeds],
            ),
            amount,
            decimals,
        )
    }

    /// Closes the actor's (empty) token account for the traded mint, rent back to the actor.
    pub fn close_token_account(&self) -> Result<()> {
        token_interface::close_account(CpiContext::new_with_signer(
            self.token_program.clone(),
            token_interface::CloseAccount {
                account: self.actor_tokens.clone(),
                destination: self.actor.clone(),
                authority: self.actor.clone(),
            },
            &[self.actor_seeds],
        ))
    }
}
