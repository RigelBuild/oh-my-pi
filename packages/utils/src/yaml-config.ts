import { YAML } from "bun";

const YAML_MAPPING_HEADER_TRAILING_SPACE = /: +$/gm;

/** Serialize config YAML without Bun's trailing space on block mapping headers. */
export function stringifyYamlConfig(value: unknown): string {
	return YAML.stringify(value, null, 2).replace(YAML_MAPPING_HEADER_TRAILING_SPACE, ":");
}

export type YamlConfigUpdate =
	| { kind: "unchanged" }
	| { kind: "updated"; content: string }
	| { kind: "unpreservable"; reason: string };

/**
 * Re-serialize `source` so it parses to the same object as
 * `stringifyYamlConfig(next)`, preserving unchanged comments and node styles.
 */
export async function updateYamlConfigSource(source: string, next: unknown): Promise<YamlConfigUpdate> {
	const target = YAML.parse(stringifyYamlConfig(next)) ?? {};
	const base = YAML.parse(source) ?? {};
	if (!isPlainMapping(base)) return { kind: "unpreservable", reason: "root is not a mapping" };
	if (Bun.deepEquals(base, target)) return { kind: "unchanged" };

	// The write-only parser stays lazy so config reads and startup do not load yaml.
	const { parseDocument, visit, isAlias, isMap, isScalar, isSeq, Scalar, LineCounter } = await import("yaml");
	const lineCounter = new LineCounter();
	const doc = parseDocument(source, { prettyErrors: false, lineCounter });
	if (doc.errors.length > 0) {
		const error = doc.errors[0];
		if (!error) return { kind: "unpreservable", reason: "YAML parse error" };
		return {
			kind: "unpreservable",
			reason: `${error.code} at line ${lineCounter.linePos(error.pos[0]).line}`,
		};
	}
	let hasAlias = false;
	visit(doc, (_key, node) => {
		if (isAlias(node)) {
			hasAlias = true;
			return visit.BREAK;
		}
	});
	if (hasAlias) return { kind: "unpreservable", reason: "anchors/aliases" };

	let root = doc.contents;
	if (!root || (isScalar(root) && root.value === null)) {
		if (isScalar(root)) {
			doc.commentBefore = [doc.commentBefore, root.commentBefore, root.comment].filter(Boolean).join("\n") || null;
		}
		doc.setIn([], doc.createNode({}));
		root = doc.contents;
	}
	if (!isMap(root)) return { kind: "unpreservable", reason: "root is not a mapping" };

	const createNode = (value: unknown) => {
		const node = doc.createNode(value);
		visit(node, (_key, child) => {
			if (isScalar(child) && typeof child.value === "string" && child.value.includes("\n")) {
				child.type = Scalar.QUOTE_DOUBLE;
			}
		});
		return node;
	};
	const setValue = (path: readonly (string | number)[], value: unknown, existing: unknown): void => {
		if (isScalar(existing) && (typeof value !== "object" || value === null)) {
			doc.setIn(path, value);
			if (typeof value === "string" && value.includes("\n")) existing.type = Scalar.QUOTE_DOUBLE;
			return;
		}
		doc.setIn(path, createNode(value));
	};
	const nodeValue = (node: unknown): unknown => {
		if (isMap(node) || isSeq(node) || isScalar(node)) return node.toJSON();
		return node;
	};

	const reconcile = (path: readonly (string | number)[], node: unknown, value: unknown): string | undefined => {
		if (isMap(node) && isPlainMapping(value)) {
			const keys: string[] = [];
			for (const pair of node.items) {
				if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
					return "mapping contains a non-string key";
				}
				keys.push(pair.key.value);
			}
			for (const key of keys) {
				if (!Object.hasOwn(value, key)) doc.deleteIn([...path, key]);
			}
			for (const key of Object.keys(value)) {
				const existing = node.get(key, true);
				const nextValue = value[key];
				if (existing === undefined) {
					doc.setIn([...path, key], createNode(nextValue));
				} else if (isMap(existing) && isPlainMapping(nextValue)) {
					const reason = reconcile([...path, key], existing, nextValue);
					if (reason) return reason;
				} else if (isSeq(existing) && Array.isArray(nextValue)) {
					const reason = reconcile([...path, key], existing, nextValue);
					if (reason) return reason;
				} else if (!Bun.deepEquals(nodeValue(existing), nextValue)) {
					setValue([...path, key], nextValue, existing);
				}
			}
			return undefined;
		}
		if (isSeq(node) && Array.isArray(value)) {
			const sharedLength = Math.min(node.items.length, value.length);
			for (let index = 0; index < sharedLength; index++) {
				const existing = node.get(index, true);
				const nextValue = value[index];
				if (isMap(existing) && isPlainMapping(nextValue)) {
					const reason = reconcile([...path, index], existing, nextValue);
					if (reason) return reason;
				} else if (isSeq(existing) && Array.isArray(nextValue)) {
					const reason = reconcile([...path, index], existing, nextValue);
					if (reason) return reason;
				} else if (!Bun.deepEquals(nodeValue(existing), nextValue)) {
					setValue([...path, index], nextValue, existing);
				}
			}
			for (let index = node.items.length - 1; index >= value.length; index--) doc.deleteIn([...path, index]);
			for (let index = node.items.length; index < value.length; index++) {
				doc.setIn([...path, index], createNode(value[index]));
			}
			return undefined;
		}
		return undefined;
	};

	const reason = reconcile([], root, target);
	if (reason) return { kind: "unpreservable", reason };
	const indent = source.match(/^( +)[^\s#]/m)?.[1]?.length ?? 2;
	const content = doc.toString({
		lineWidth: 0,
		indent,
		flowCollectionPadding: false,
		doubleQuotedMinMultiLineLength: Infinity,
	});
	if (!Bun.deepEquals(YAML.parse(content), target)) {
		return { kind: "unpreservable", reason: "round-trip mismatch" };
	}
	return { kind: "updated", content };
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
