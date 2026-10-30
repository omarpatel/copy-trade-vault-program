use anchor_lang::prelude::*;

#[error_code]
pub enum CopierError {
    // ---------------- admin / config ----------------
    #[msg("Signer is not the program upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Signer is not the config admin")]
    NotAdmin,
    #[msg("Signer is not the pending admin")]
    NotPendingAdmin,
    #[msg("Signer is not the keeper")]
    NotKeeper,
    #[msg("Parameter outside its allowed range")]
    ParamOutOfRange,
    #[msg("Too many trade descriptors")]
    TooManyDescriptors,
    #[msg("Descriptor targets a program other than pump or pump_amm")]
    DescriptorProgramNotAllowed,
    #[msg("Descriptor discriminator is never allowed (create/extend/volume accumulator/migrate/deposit/withdraw/admin)")]
    DescriptorDiscForbidden,
    #[msg("Descriptor account indices are inconsistent or min_accounts exceeds 40")]
    DescriptorIndices,
    #[msg("the platform token mint already set")]
    PlatformMintAlreadySet,
    #[msg("the platform token mint must be a registered Index copier")]
    PlatformMintNotIndex,
    #[msg("Descriptors must keep at least one Buy and one Sell descriptor for both the curve and the pool")]
    DescriptorsIncomplete,
    #[msg("Timelock must be between 60 seconds and 7 days")]
    TimelockOutOfRange,
    #[msg("The change's timelock has not elapsed")]
    TimelockNotElapsed,
    #[msg("Pending change payload does not match its kind or accounts")]
    PendingChangeInvalid,

    // ---------------- registration ----------------
    #[msg("Trader cut must be between 100 and 2500 bps")]
    TraderBpsOutOfRange,
    #[msg("Sharing config is not the canonical pump_fees PDA for this mint")]
    SharingConfigMismatch,
    #[msg("Sharing config account is not a pump_fees SharingConfig")]
    SharingConfigInvalid,
    #[msg("Sharing config version must be 2")]
    SharingConfigVersion,
    #[msg("Sharing config is not active")]
    SharingConfigNotActive,
    #[msg("Sharing config admin is not revoked (split not immutable)")]
    SharingConfigAdminNotRevoked,
    #[msg("Shareholders must be exactly [target X, vault 10000-X] (index: [vault 10000])")]
    ShareholdersMismatch,
    #[msg("Bonding curve is not the canonical pump PDA for this mint")]
    BondingCurveMismatch,
    #[msg("Bonding curve account is not a pump BondingCurve")]
    BondingCurveInvalid,
    #[msg("Bonding curve creator is not the sharing config")]
    CreatorNotSharingConfig,
    #[msg("Bonding curve already complete")]
    CurveComplete,
    #[msg("Mayhem-mode coins are not supported")]
    MayhemCoin,
    #[msg("Cashback coins are not supported")]
    CashbackCoin,
    #[msg("Holder-reward coins are not supported")]
    HolderRewardCoin,
    #[msg("Only SOL-quoted coins are supported")]
    NotSolQuoted,
    #[msg("Mint is not a Token-2022 mint")]
    MintNotToken2022,
    #[msg("Mint has an authority or an extension that could block transfers or burns")]
    MintUnsafe,
    #[msg("Target must be a system-owned, non-executable wallet")]
    TargetInvalid,
    #[msg("Vault must be the system-owned, zero-data vault PDA")]
    VaultInvalid,
    #[msg("Index target list is empty, too long or has duplicates")]
    InvalidTargets,
    #[msg("Not an Index copier")]
    NotIndex,
    #[msg("Cannot remove a target that still has open positions")]
    TargetHasOpenPositions,

    // ---------------- trading ----------------
    #[msg("Target index out of range")]
    TargetIndex,
    #[msg("Target account does not match the copier's target")]
    TargetMismatch,
    #[msg("Target token account is not the canonical ATA")]
    TargetTokenAccount,
    #[msg("Descriptor index out of range")]
    DescriptorIndex,
    #[msg("Descriptor side does not match the instruction")]
    DescriptorSide,
    #[msg("Instruction data does not start with the descriptor's discriminator")]
    DiscriminatorMismatch,
    #[msg("Not enough venue accounts for this descriptor")]
    NotEnoughAccounts,
    #[msg("Venue program account missing or not the descriptor's program")]
    VenueProgram,
    #[msg("remaining[user_idx] is not the trading PDA")]
    UserMismatch,
    #[msg("The trading PDA appears in the venue accounts outside user_idx")]
    UserElsewhere,
    #[msg("remaining[base_mint_idx] is not the traded mint")]
    MintMismatch,
    #[msg("Venue account is not the canonical bonding curve / pool for the mint")]
    VenueMismatch,
    #[msg("Venue account is invalid, not SOL-quoted, mayhem or the wrong kind")]
    VenueInvalid,
    #[msg("A writable token account owned by the trading PDA is not the traded mint / wSOL account")]
    ForeignVaultTokenAccount,
    #[msg("Cannot copy-trade the copier's own coin")]
    OwnMint,
    #[msg("Target balance did not increase")]
    NoTargetIncrease,
    #[msg("Target buy is below the minimum signal")]
    SignalTooSmall,
    #[msg("Trade exceeds signal x signal_multiple")]
    ExceedsSignal,
    #[msg("Trade exceeds max_trade_bps of equity")]
    ExceedsTradeCap,
    #[msg("Position would exceed max_position_bps of equity")]
    ExceedsPositionCap,
    #[msg("Trade exceeds max_impact_bps of the venue's real quote reserves")]
    ExceedsImpact,
    #[msg("Trade below min_trade_lamports")]
    TradeTooSmall,
    #[msg("Trade would take free SOL below the vault floor")]
    BelowVaultFloor,
    #[msg("Too many open positions")]
    TooManyPositions,
    #[msg("Position belongs to another target")]
    PositionTargetMismatch,
    #[msg("Position account is invalid")]
    PositionInvalid,
    #[msg("No open position for this mint")]
    NoPosition,
    #[msg("Venue returned fewer tokens than the floor")]
    SlippageTokens,
    #[msg("Venue returned less SOL than the floor")]
    SlippageSol,
    #[msg("Venue spent more than sol_in plus the rent allowance")]
    Overspent,
    #[msg("Venue sold a different amount of tokens than tokens_in")]
    SellAmountMismatch,
    #[msg("Sell exceeds the target-proportional allowance")]
    SellNotAllowed,
    #[msg("Only the keeper may sell before the grace period ends while the target holds tokens")]
    SellNotPermitted,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Exceeds the buyback pool")]
    ExceedsBuybackPool,
    #[msg("buyback_burn called again within 60 seconds")]
    BuybackTooSoon,
    #[msg("Burn pool does not hold enough SOL")]
    ExceedsBurnPool,
    #[msg("the platform token mint not set")]
    PlatformMintNotSet,
    #[msg("Vault balance is below what the program accounted (lamports left without the program)")]
    AccountingBroken,
    #[msg("Token account is not the canonical ATA")]
    TokenAccountMismatch,
    #[msg("Another instruction in this transaction touches a venue or is not allowed next to a copy-vault trade")]
    VenueTouchedInTx,
    #[msg("copy-vault trades must be top-level instructions, not CPIs")]
    NotTopLevel,
    #[msg("Buy would exceed the copier's spend limit for the current window")]
    SpendWindowExceeded,
    #[msg("Only one permissionless sell per copier per slot")]
    PublicSellRateLimited,
    #[msg("burn_platform called again within 60 seconds")]
    PlatformBurnTooSoon,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("A newer proposal of the same kind (or a keeper pause / admin handover) replaced this change")]
    PendingChangeSuperseded,
    #[msg("The change's execution window has passed")]
    PendingChangeExpired,
    #[msg("The change is neither superseded nor expired")]
    PendingChangeLive,
    #[msg("Each venue must keep a Sell descriptor identical to a proven one of the current list")]
    DescriptorsDropProvenExit,
}
