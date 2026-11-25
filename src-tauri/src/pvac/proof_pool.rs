use std::sync::{Arc, OnceLock, RwLock};

static POOL: OnceLock<RwLock<Arc<rayon::ThreadPool>>> = OnceLock::new();

fn build(threads: usize) -> Arc<rayon::ThreadPool> {
    Arc::new(
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads.max(1))
            .thread_name(|i| format!("proof-{i}"))
            .build()
            .expect("proof thread pool"),
    )
}

/// Proofs already running keep the pool they started on.
pub fn set(threads: usize) {
    let pool = build(threads);
    match POOL.get() {
        Some(slot) => *slot.write().unwrap_or_else(|e| e.into_inner()) = pool,
        None => {
            let _ = POOL.set(RwLock::new(pool));
        }
    }
}

fn current() -> Arc<rayon::ThreadPool> {
    POOL.get_or_init(|| RwLock::new(build(4)))
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

pub fn threads() -> usize {
    current().current_num_threads()
}

pub fn install<R: Send>(f: impl FnOnce() -> R + Send) -> R {
    current().install(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_setting_applies_to_the_next_proof() {
        set(2);
        assert_eq!(install(rayon::current_num_threads), 2);
        set(3);
        assert_eq!(threads(), 3);
        assert_eq!(install(rayon::current_num_threads), 3);
    }
}
