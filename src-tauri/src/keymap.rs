//! Translation from the DOM `KeyboardEvent.code` namespace to `enigo::Key`.
//!
//! `code` is used rather than `key` because it identifies the *physical* key
//! independent of the remote user's keyboard layout or active modifiers, which
//! is what an OS-level injection API expects.

use enigo::Key;

/// Maps a `KeyboardEvent.code` value to an injectable key.
///
/// Returns `None` for codes with no OS equivalent, which the caller should
/// ignore rather than treat as an error.
pub fn code_to_key(code: &str) -> Option<Key> {
    // Letters: `KeyA`..`KeyZ`
    if let Some(letter) = code.strip_prefix("Key") {
        let mut chars = letter.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_alphabetic() {
                return Some(Key::Unicode(c.to_ascii_lowercase()));
            }
        }
        return None;
    }

    // Top-row digits: `Digit0`..`Digit9`
    if let Some(digit) = code.strip_prefix("Digit") {
        let mut chars = digit.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_digit() {
                return Some(Key::Unicode(c));
            }
        }
        return None;
    }

    // Numpad digits: `Numpad0`..`Numpad9`
    if let Some(digit) = code.strip_prefix("Numpad") {
        if let Ok(n) = digit.parse::<u8>() {
            return match n {
                0 => Some(Key::Numpad0),
                1 => Some(Key::Numpad1),
                2 => Some(Key::Numpad2),
                3 => Some(Key::Numpad3),
                4 => Some(Key::Numpad4),
                5 => Some(Key::Numpad5),
                6 => Some(Key::Numpad6),
                7 => Some(Key::Numpad7),
                8 => Some(Key::Numpad8),
                9 => Some(Key::Numpad9),
                _ => None,
            };
        }
    }

    // Function keys: `F1`..`F24`
    if let Some(num) = code.strip_prefix('F') {
        if let Ok(n) = num.parse::<u8>() {
            return function_key(n);
        }
    }

    Some(match code {
        // Whitespace and editing
        "Enter" | "NumpadEnter" => Key::Return,
        "Tab" => Key::Tab,
        "Space" => Key::Space,
        "Backspace" => Key::Backspace,
        "Delete" => Key::Delete,
        "Escape" => Key::Escape,

        // Navigation
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,

        // Modifiers
        "ShiftLeft" | "ShiftRight" => Key::Shift,
        "ControlLeft" | "ControlRight" => Key::Control,
        "AltLeft" | "AltRight" => Key::Alt,
        "MetaLeft" | "MetaRight" => Key::Meta,
        "CapsLock" => Key::CapsLock,

        // Punctuation and Numpad math operators
        "Minus" => Key::Unicode('-'),
        "NumpadSubtract" => Key::Subtract,
        "Equal" => Key::Unicode('='),
        "NumpadAdd" => Key::Add,
        "NumpadMultiply" => Key::Multiply,
        "NumpadDivide" => Key::Divide,
        "NumpadDecimal" => Key::Decimal,
        "BracketLeft" => Key::Unicode('['),
        "BracketRight" => Key::Unicode(']'),
        "Backslash" => Key::Unicode('\\'),
        "Semicolon" => Key::Unicode(';'),
        "Quote" => Key::Unicode('\''),
        "Backquote" => Key::Unicode('`'),
        "Comma" => Key::Unicode(','),
        "Period" => Key::Unicode('.'),
        "Slash" => Key::Unicode('/'),

        _ => return None,
    })
}

fn function_key(n: u8) -> Option<Key> {
    Some(match n {
        1 => Key::F1,
        2 => Key::F2,
        3 => Key::F3,
        4 => Key::F4,
        5 => Key::F5,
        6 => Key::F6,
        7 => Key::F7,
        8 => Key::F8,
        9 => Key::F9,
        10 => Key::F10,
        11 => Key::F11,
        12 => Key::F12,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_letters_to_lowercase_unicode() {
        assert!(matches!(code_to_key("KeyA"), Some(Key::Unicode('a'))));
        assert!(matches!(code_to_key("KeyZ"), Some(Key::Unicode('z'))));
    }

    #[test]
    fn maps_digits_from_both_rows() {
        assert!(matches!(code_to_key("Digit7"), Some(Key::Unicode('7'))));
        assert!(matches!(code_to_key("Numpad7"), Some(Key::Numpad7)));
    }

    #[test]
    fn maps_named_and_function_keys() {
        assert!(matches!(code_to_key("Enter"), Some(Key::Return)));
        assert!(matches!(code_to_key("F5"), Some(Key::F5)));
    }

    #[test]
    fn rejects_unknown_codes() {
        assert!(code_to_key("Fn").is_none());
        assert!(code_to_key("KeyAB").is_none());
        assert!(code_to_key("MediaPlayPause").is_none());
    }
}
