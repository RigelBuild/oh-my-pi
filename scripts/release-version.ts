export function applyPackageVersion(content: string, version: string): string {
	return content.replace(/"version": "[^"]+"/g, `"version": "${version}"`);
}

export function applyCargoWorkspaceVersion(content: string, version: string): string {
	return content.replace(/^version = "[^"]+"/gm, `version = "${version}"`);
}

export function applyCargoLockWorkspaceVersion(content: string, version: string): string {
	return content.replace(/\[\[package\]\]\n(?:(?!\[\[package\]\]\n)[\s\S])*/g, entry => {
		if (/^source = /m.test(entry)) return entry;
		return entry.replace(/^version = "[^"]+"/m, `version = "${version}"`);
	});
}

export function applyCatalogVersion(content: string, version: string): string {
	return content.replace(/("@oh-my-pi\/[^\"]+":\s*)"[^\"]+"/g, `$1"${version}"`);
}
