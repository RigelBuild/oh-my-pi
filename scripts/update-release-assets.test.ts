import { describe, expect, it } from "bun:test";
import { parseSha256Sums, renderReleaseAssets } from "./update-release-assets";

const checksums: Record<string, string> = {
	"omp-linux-x64": "0000000000000000000000000000000000000000000000000000000000000000",
	"omp-linux-arm64": "1111111111111111111111111111111111111111111111111111111111111111",
	"omp-darwin-arm64": "2222222222222222222222222222222222222222222222222222222222222222",
	"omp-darwin-x64": "3333333333333333333333333333333333333333333333333333333333333333",
};

describe("release asset generator", () => {
	it("renders the pinned assets in Nix format from a bare version", () => {
		const output = renderReleaseAssets("18.9.2-rigel.2", checksums);
		expect(output).toContain('version = "18.9.2-rigel.2";');
		expect(output).toContain('hash = "sha256-ERERERERERERERERERERERERERERERERERERERERERE=";');
		expect(output).toContain('name = "omp-darwin-x64";');
		expect(output.endsWith("};\n  };\n}\n")).toBe(true);
	});

	it("reports an asset absent from SHA256SUMS.txt", () => {
		const incomplete: Record<string, string> = { ...checksums };
		delete incomplete["omp-linux-arm64"];
		expect(() => renderReleaseAssets("18.9.2-rigel.2", incomplete)).toThrow(
			"SHA256SUMS.txt has no checksum for omp-linux-arm64",
		);
	});

	it("rejects malformed SHA256SUMS.txt lines", () => {
		expect(() => parseSha256Sums("not-a-checksum  omp-linux-x64")).toThrow(
			"invalid SHA256SUMS.txt line: not-a-checksum  omp-linux-x64",
		);
	});
});
