//! Writing floats (spec §15): one exact spelling per value of the type, so
//! that every binding gives the same float the same text, canonical form and
//! hash. Decoding is in `de` (Rust's `parse` already rounds correctly).

use std::fmt::LowerExp;
use std::str::FromStr;

/// The one spelling of a finite float of the type `F`: the fewest digits that
/// read back as the same `F`, the closest of them (ties to even), laid out
/// like JavaScript's `Number.prototype.toString` without `+` in the
/// exponent. `1`, `0.1`, `1.5e-7`, `1e21`, `-0`.
pub(crate) fn text<F>(x: F) -> String
where
    F: Copy + PartialEq + LowerExp + FromStr + Into<f64>,
{
    // LowerExp writes the fewest digits that read back as the same `F`.
    let shortest = format!("{x:e}");
    let (sign, magnitude) = shortest.strip_prefix('-').map_or(("", shortest.as_str()), |m| ("-", m));
    let (digits, exp) = digits(magnitude);
    let reads_back = |d: u64| format!("{sign}{d}e{exp}").parse::<F>().is_ok_and(|y| y == x);
    let digits = ties_to_even(digits, exp, x.into().abs(), reads_back);
    format!("{sign}{}", layout(digits, exp))
}

/// `d.ddde<exp>` as digits and exponent: `1.5e-7` is (15, -8), 15 × 10⁻⁸.
fn digits(lower_exp: &str) -> (u64, i32) {
    let (mantissa, exp) = lower_exp.split_once('e').unwrap_or((lower_exp, "0"));
    let fraction = mantissa.split_once('.').map_or(0, |(_, f)| f.len() as i32);
    // At most 17 digits, which fit a u64.
    (mantissa.replace('.', "").parse().unwrap_or(0), exp.parse::<i32>().unwrap_or(0) - fraction)
}

/// When `x` lies exactly half way between the shortest digits `d` and a
/// neighbour that also reads back as `x`, the even one of the two. Rust picks
/// the upper one; JavaScript, and so the spec, the even one.
fn ties_to_even(d: u64, exp: i32, x: f64, reads_back: impl Fn(u64) -> bool) -> u64 {
    if d.is_multiple_of(2) {
        return d;
    }
    [d - 1, d + 1]
        .into_iter()
        .filter(|&other| other > 0 && other.ilog10() == d.ilog10())
        .find(|&other| equals_decimal(x, 10 * d.min(other) + 5, exp - 1) && reads_back(other))
        .unwrap_or(d)
}

/// Whether the finite `x` ≥ 0 is exactly `n` × 10^`t`. Both are 2^a × 5^b × c
/// with c coprime to 10, and equal when a, b and c are.
fn equals_decimal(x: f64, n: u64, t: i32) -> bool {
    let bits = x.to_bits();
    let (biased, fraction) = (((bits >> 52) & 0x7ff) as i32, bits & ((1 << 52) - 1));
    // x = m × 2^q.
    let (m, q) = if biased == 0 { (fraction, -1074) } else { (fraction | 1 << 52, biased - 1075) };
    if m == 0 || n == 0 {
        return m == n;
    }
    let ((m, m2), (n, n2)) = (strip(m, 2), strip(n, 2));
    let ((m, m5), (n, n5)) = (strip(m, 5), strip(n, 5));
    m == n && q + m2 == t + n2 && m5 == t + n5
}

/// `n` > 0 without its factors `p`, and how many there were.
fn strip(n: u64, p: u64) -> (u64, i32) {
    std::iter::successors(Some((n, 0)), |&(n, count)| n.is_multiple_of(p).then_some((n / p, count + 1)))
        .last()
        .unwrap_or((n, 0))
}

/// Digits `d₁…dₖ` and exponent `exp` laid out like JavaScript's
/// `Number.prototype.toString`, with the value as 0.d₁…dₖ × 10ⁿ (spec §15).
fn layout(d: u64, exp: i32) -> String {
    let digits = d.to_string();
    let k = digits.len() as i32;
    let n = exp + k;
    let zeros = |count: i32| "0".repeat(count.max(0) as usize);
    match n {
        n if k <= n && n <= 21 => digits + &zeros(n - k),
        n if 0 < n && n <= 21 => format!("{}.{}", &digits[..n as usize], &digits[n as usize..]),
        n if -6 < n && n <= 0 => format!("0.{}{digits}", zeros(-n)),
        n => match digits.split_at(1) {
            (first, "") => format!("{first}e{}", n - 1),
            (first, rest) => format!("{first}.{rest}e{}", n - 1),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::text;

    #[test]
    fn layout_like_javascript() {
        let cases: [(f64, &str); 14] = [
            (1.0, "1"),
            (100.0, "100"),
            (123000.0, "123000"),
            (1.5, "1.5"),
            (12.25, "12.25"),
            (0.1, "0.1"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e21"),
            (-1.5e300, "-1.5e300"),
            (0.0, "0"),
            (-0.0, "-0"),
        ];
        for (x, want) in cases {
            assert_eq!(text(x), want, "{x:e}");
        }
        assert_eq!(text(0.1f32), "0.1");
        assert_eq!(text(f32::MAX), "3.4028235e38");
        assert_eq!(text(f32::from_bits(1)), "1e-45");
    }

    #[test]
    fn ties_go_to_even() {
        // Exactly half way between the shortest candidates …323.2 and …323.3.
        let tie = 1690060720831323.0 + 0.25;
        assert_eq!(text(tie), "1690060720831323.2");
        assert_eq!(text(-tie), "-1690060720831323.2");
        // As Float32, 2097152.2 and 2097152.3 both read back as 2097152.25.
        assert_eq!(text(2097152.0f32 + 0.25), "2097152.2");
        assert_eq!(text(2097152.0f32 + 0.75), "2097152.8");
        // Not a tie: the closer one is written.
        assert_eq!(text(1048576.0f32 + 0.125), "1048576.1");
    }
}
