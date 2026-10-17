import { describe, expect, it } from "bun:test";
import { YAML } from "bun";
import { updateYamlConfigSource } from "../src/yaml-config";

function parseYaml(source: string): Record<string, unknown> {
	const parsed: unknown = YAML.parse(source);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Expected a YAML mapping");
	}
	return parsed as Record<string, unknown>;
}

describe("updateYamlConfigSource", () => {
	it("keeps comments across unrelated leaf updates", async () => {
		const source = [
			"# file-top comment",
			"root: before",
			"# above key",
			"changed: old # inline after value",
			"items:",
			"  - alpha # first item",
			"  # inside a list",
			"  - beta",
			"nested:",
			"  # above nested key",
			"  keep: yes",
			"",
		].join("\n");
		const result = await updateYamlConfigSource(source, {
			root: "before",
			changed: "new",
			items: ["alpha", "beta"],
			nested: { keep: true },
		});

		expect(result.kind).toBe("updated");
		if (result.kind !== "updated") return;
		expect(parseYaml(result.content)).toEqual({
			root: "before",
			changed: "new",
			items: ["alpha", "beta"],
			nested: { keep: true },
		});
		for (const comment of [
			"# file-top comment",
			"# above key",
			"# inline after value",
			"# first item",
			"# inside a list",
			"# above nested key",
		]) {
			expect(result.content).toContain(comment);
		}
	});

	it("updates a scalar in place and keeps its inline comment", async () => {
		const result = await updateYamlConfigSource("value: old # keep this\n", { value: "new" });
		expect(result).toEqual({ kind: "updated", content: "value: new # keep this\n" });
	});

	it("adds a nested key under a commented map without touching siblings", async () => {
		const source = "# map comment\nparent:\n  # sibling comment\n  keep: same\n";
		const result = await updateYamlConfigSource(source, { parent: { keep: "same", added: "value" } });
		expect(result.kind).toBe("updated");
		if (result.kind !== "updated") return;
		expect(parseYaml(result.content)).toEqual({ parent: { keep: "same", added: "value" } });
		expect(result.content).toContain("# map comment");
		expect(result.content).toContain("# sibling comment");
	});

	it("deletes absent keys, including flat legacy keys", async () => {
		const result = await updateYamlConfigSource('keep: value\n"dev.autoqa.consent": unset\nremoved: old\n', {
			keep: "value",
			added: true,
		});
		expect(result.kind).toBe("updated");
		if (result.kind !== "updated") return;
		expect(parseYaml(result.content)).toEqual({ keep: "value", added: true });
		expect(result.content).not.toContain("dev.autoqa.consent");
		expect(result.content).not.toContain("removed:");
	});

	it("replaces a map with a scalar and a scalar with a map", async () => {
		const toScalar = await updateYamlConfigSource("value:\n  nested: old\n", { value: "flat" });
		expect(toScalar.kind).toBe("updated");
		if (toScalar.kind === "updated") expect(parseYaml(toScalar.content)).toEqual({ value: "flat" });

		const toMap = await updateYamlConfigSource("value: flat\n", { value: { nested: "new" } });
		expect(toMap.kind).toBe("updated");
		if (toMap.kind === "updated") expect(parseYaml(toMap.content)).toEqual({ value: { nested: "new" } });
	});

	it("preserves per-role comments when another model role changes or is removed", async () => {
		const source = [
			"modelRoles:",
			"  default: old # default role",
			"  # advisor role",
			"  advisor: keep # advisor inline",
			"  # smol role",
			"  smol: remove",
			"",
		].join("\n");
		const changed = await updateYamlConfigSource(source, {
			modelRoles: { default: "new", advisor: "keep", smol: "remove" },
		});
		expect(changed.kind).toBe("updated");
		if (changed.kind === "updated") {
			expect(parseYaml(changed.content)).toEqual({
				modelRoles: { default: "new", advisor: "keep", smol: "remove" },
			});
			expect(changed.content).toContain("# default role");
			expect(changed.content).toContain("# advisor role");
			expect(changed.content).toContain("# advisor inline");
		}
		const removed = await updateYamlConfigSource(source, { modelRoles: { default: "old", advisor: "keep" } });
		expect(removed.kind).toBe("updated");
		if (removed.kind === "updated") {
			expect(parseYaml(removed.content)).toEqual({ modelRoles: { default: "old", advisor: "keep" } });
			expect(removed.content).toContain("# advisor role");
			expect(removed.content).toContain("# advisor inline");
		}
	});

	it("reconciles sequences without losing unchanged item comments", async () => {
		const source =
			"items:\n  - changed # first\n  # second item\n  - keep # second inline\n  - tail # removed tail\n";
		const changed = await updateYamlConfigSource(source, { items: ["new", "keep", "tail"] });
		expect(changed.kind).toBe("updated");
		if (changed.kind === "updated") {
			expect(parseYaml(changed.content)).toEqual({ items: ["new", "keep", "tail"] });
			expect(changed.content).toContain("# first");
			expect(changed.content).toContain("# second item");
			expect(changed.content).toContain("# second inline");
		}
		const shortened = await updateYamlConfigSource(source, { items: ["changed", "keep"] });
		expect(shortened.kind).toBe("updated");
		if (shortened.kind === "updated") {
			expect(parseYaml(shortened.content)).toEqual({ items: ["changed", "keep"] });
			expect(shortened.content).not.toContain("removed tail");
		}
		const lengthened = await updateYamlConfigSource("items:\n  - one\n", { items: ["one", "two"] });
		expect(lengthened.kind).toBe("updated");
		if (lengthened.kind === "updated") expect(parseYaml(lengthened.content)).toEqual({ items: ["one", "two"] });
		const nested = await updateYamlConfigSource("items:\n  - name: old\n  - # keep sibling\n    name: keep\n", {
			items: [{ name: "new" }, { name: "keep" }],
		});
		expect(nested.kind).toBe("updated");
		if (nested.kind === "updated") {
			expect(parseYaml(nested.content)).toEqual({ items: [{ name: "new" }, { name: "keep" }] });
			expect(nested.content).toContain("# keep sibling");
		}
	});

	it("retains detected 4-space indentation", async () => {
		const result = await updateYamlConfigSource("root: old\nparent:\n    nested: old\n", {
			root: "new",
			parent: { nested: "new" },
		});
		expect(result.kind).toBe("updated");
		if (result.kind === "updated") expect(result.content).toContain("    nested: new");
	});

	it("returns unchanged source bytes regardless of flow formatting and indentation", async () => {
		const source = "# original\nparent:\n    items: [a, b]\n";
		expect(await updateYamlConfigSource(source, { parent: { items: ["a", "b"] } })).toEqual({ kind: "unchanged" });
	});

	it("rejects duplicate keys without exposing key or value text", async () => {
		const source = "secrets:\n  token: FIRST-FAKE-SECRET\n  token: SECOND-FAKE-SECRET\n";
		const result = await updateYamlConfigSource(source, { secrets: { token: "new" } });
		expect(result.kind).toBe("unpreservable");
		if (result.kind === "unpreservable") {
			expect(result.reason).toContain("DUPLICATE_KEY");
			expect(result.reason).toContain("line 3");
			expect(result.reason).not.toContain("token");
			expect(result.reason).not.toContain("FIRST-FAKE-SECRET");
			expect(result.reason).not.toContain("SECOND-FAKE-SECRET");
		}
	});

	it("rejects aliases", async () => {
		const result = await updateYamlConfigSource("base: &base value\ncopy: *base\n", { base: "new", copy: "new" });
		expect(result).toEqual({ kind: "unpreservable", reason: "anchors/aliases" });
	});

	it("adds keys to comment-only, empty, and null documents while keeping comments", async () => {
		for (const source of [
			"# only comment\n",
			"",
			"---\n# document comment\n",
			"# null comment\nnull # inline null\n",
		]) {
			const result = await updateYamlConfigSource(source, { added: "value" });
			expect(result.kind).toBe("updated");
			if (result.kind !== "updated") continue;
			expect(parseYaml(result.content)).toEqual({ added: "value" });
			if (source.includes("comment")) expect(result.content).toContain("comment");
			if (source.includes("inline null")) expect(result.content).toContain("inline null");
		}
	});

	it("quotes changed and inserted multiline strings without trailing-space-strip artifacts", async () => {
		const unchangedScalar = "before\nafter";
		const changed = await updateYamlConfigSource("existing: old # inline\n", { existing: unchangedScalar });
		expect(changed.kind).toBe("updated");
		if (changed.kind === "updated") {
			expect(parseYaml(changed.content)).toEqual({ existing: unchangedScalar });
			expect(changed.content).toContain("# inline");
			expect(changed.content).not.toMatch(/: +$/m);
		}
		const inserted = await updateYamlConfigSource("existing: value\n", {
			existing: "value",
			added: unchangedScalar,
			nested: { value: unchangedScalar },
		});
		expect(inserted.kind).toBe("updated");
		if (inserted.kind === "updated") {
			expect(parseYaml(inserted.content)).toEqual({
				existing: "value",
				added: unchangedScalar,
				nested: { value: unchangedScalar },
			});
			expect(inserted.content).not.toMatch(/: +$/m);
		}
	});

	it("omits undefined-valued keys through the existing normalizer", async () => {
		const result = await updateYamlConfigSource("keep: value\n", { keep: "value", omitted: undefined });
		expect(result.kind).toBe("unchanged");
	});
});
