//! Helpers shared by the crate's unit tests.

use std::{fs, io, path::Path, process::Command};

/// Write `contents` to `path` and make it executable.
///
/// A child `sh` writes the file, so this process never holds a write fd on
/// it. A write fd this process holds can be inherited by a `fork` in a
/// sibling test thread; until that child `exec`s, exec of `path` fails with
/// `ETXTBSY`. The writer exits before this returns, so the file is closed
/// before any caller execs it.
///
/// # Errors
/// Returns the error when the writer cannot start, exits non-zero, or the
/// mode cannot be set.
pub(crate) fn write_exec_script(path: &Path, contents: &str) -> io::Result<()> {
	use std::os::unix::fs::PermissionsExt as _;

	let status = Command::new("sh")
		.arg("-c")
		.arg(r#"printf '%s' "$1" > "$2""#)
		.arg("sh")
		.arg(contents)
		.arg(path)
		.status()?;
	if !status.success() {
		return Err(io::Error::other(format!("writing {} exited with {status}", path.display())));
	}
	fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}
