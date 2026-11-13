/**
 * The characters Python's `re` module matches with \s in a str pattern
 * (`str.isspace()`), as JavaScript character class contents for a pattern
 * with the `u` flag. The data repository's validator runs on Python 3.12
 * (Unicode 15.0), whose \s is wider than JavaScript's: it also holds the
 * information separators U+001C to U+001F and U+0085. Made by testing every
 * code point outside the surrogates against `re.fullmatch` in that Python,
 * and joining the matches into ranges.
 */
export const PYTHON_SPACE =
  "\\u{9}-\\u{d}\\u{1c}-\\u{20}\\u{85}\\u{a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}-\\u{2029}\\u{202f}\\u{205f}\\u{3000}";
