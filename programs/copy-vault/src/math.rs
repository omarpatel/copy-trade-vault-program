//! Overflow-safe integer math: every product is taken in u128 and every narrowing is checked.

use anchor_lang::prelude::*;

use crate::constants::BPS;
use crate::errors::CopierError;

fn narrow(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(CopierError::MathOverflow))
}

/// floor(a × b / c); c = 0 yields 0 (an empty reserve prices nothing).
pub fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    if c == 0 {
        return Ok(0);
    }
    narrow(a as u128 * b as u128 / c as u128)
}

/// ceil(a × b / c); c must be non-zero.
pub fn mul_div_ceil(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c > 0, CopierError::MathOverflow);
    narrow((a as u128 * b as u128).div_ceil(c as u128))
}

/// floor(amount × bps / 10_000).
pub fn bps_of(amount: u64, bps: u64) -> Result<u64> {
    mul_div(amount, bps, BPS)
}

/// The program's fill floor: (10_000 − slippage_bps) of a fee-free quote.
pub fn floor_after_slippage(quote: u64, slippage_bps: u16) -> Result<u64> {
    bps_of(quote, BPS.saturating_sub(slippage_bps as u64))
}

/// Constant product (quote reserve `q`, token reserve `t`): fee-free tokens out for `quote_in`.
pub fn cp_tokens_out(q: u64, t: u64, quote_in: u64) -> Result<u64> {
    let den = q as u128 + quote_in as u128;
    if den == 0 {
        return Ok(0);
    }
    narrow(t as u128 * quote_in as u128 / den)
}

/// Constant product: fee-free quote out for `tokens_in`.
pub fn cp_quote_out(q: u64, t: u64, tokens_in: u64) -> Result<u64> {
    let den = t as u128 + tokens_in as u128;
    if den == 0 {
        return Ok(0);
    }
    narrow(q as u128 * tokens_in as u128 / den)
}

/// Signed difference `a − b` of two lamport amounts.
pub fn signed_diff(a: u64, b: u64) -> Result<i64> {
    i64::try_from(a as i128 - b as i128).map_err(|_| error!(CopierError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_handles_u64_extremes() {
        assert_eq!(mul_div(u64::MAX, u64::MAX, u64::MAX).unwrap(), u64::MAX);
        assert!(mul_div(u64::MAX, 2, 1).is_err());
        assert_eq!(mul_div(5, 7, 0).unwrap(), 0);
        assert_eq!(mul_div_ceil(10, 1, 3).unwrap(), 4);
    }

    #[test]
    fn constant_product_never_exceeds_reserves() {
        let (q, t) = (30_000_000_000u64, 1_073_000_000_000_000u64);
        let out = cp_tokens_out(q, t, u64::MAX).unwrap();
        assert!(out < t);
        let back = cp_quote_out(q, t, u64::MAX).unwrap();
        assert!(back < q);
        assert_eq!(floor_after_slippage(10_000, 500).unwrap(), 9_500);
    }

    #[test]
    fn signed_diff_is_exact() {
        assert_eq!(signed_diff(5, 7).unwrap(), -2);
        assert_eq!(signed_diff(u64::MAX, 0).ok(), None);
    }
}
