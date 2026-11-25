use rand::RngCore;

fn v4_bytes() -> [u8; 16] {
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    b
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

pub fn new_v4() -> String {
    let b = v4_bytes();
    format!(
        "{}-{}-{}-{}-{}",
        hex(&b[0..4]),
        hex(&b[4..6]),
        hex(&b[6..8]),
        hex(&b[8..10]),
        hex(&b[10..16])
    )
}

pub fn new_v4_simple() -> String {
    hex(&v4_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hyphenated_v4_shape() {
        let id = new_v4();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(id
            .chars()
            .all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert!(parts[2].starts_with('4'));
        assert!(matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'));
    }

    #[test]
    fn simple_v4_shape_and_unique() {
        let a = new_v4_simple();
        assert_eq!(a.len(), 32);
        assert_eq!(&a[12..13], "4");
        assert_ne!(a, new_v4_simple());
    }
}
