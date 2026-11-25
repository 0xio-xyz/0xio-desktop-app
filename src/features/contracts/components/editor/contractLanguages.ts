import { StreamLanguage, type StringStream } from "@codemirror/language";
import { type Completion } from "@codemirror/autocomplete";

// Hand-rolled stream tokenizers: AML and OASM have no published grammars, and a
// StreamLanguage is a fraction of the weight of a Lezer grammar for two small DSLs.

const AML_KEYWORDS = new Set([
  "Program",
  "Contract",
  "import",
  "from",
  "implements",
  "invariant",
  "interface",
  "private",
  "public",
  "internal",
  "payable",
  "nonreentrant",
  "assert",
  "error",
  "indexed",
  "match",
  "fn",
  "view",
  "state",
  "struct",
  "enum",
  "const",
  "event",
  "emit",
  "constructor",
  "let",
  "if",
  "else",
  "while",
  "for",
  "in",
  "return",
  "true",
  "false",
]);

const AML_TYPES = new Set([
  "int",
  "u64",
  "u128",
  "u256",
  "string",
  "address",
  "bool",
  "bytes",
  "cipher",
  "pubkey",
  "map",
  "list",
  "void",
]);

// The canonical builtin inventory (webcli static/wallet.js highlighter).
const AML_BUILTINS = new Set([
  "require",
  "call",
  "transfer",
  "emit",
  "log",
  "checkpoint",
  "rollback",
  "commit",
  "caller",
  "self_addr",
  "origin",
  "value",
  "epoch",
  "balance",
  "self",
  "to_int",
  "to_string",
  "min",
  "max",
  "abs",
  "pow",
  "concat",
  "len",
  "split",
  "join",
  "replace",
  "starts_with",
  "substr",
  "index_of",
  "bit_and",
  "bit_or",
  "bit_xor",
  "parse_ints",
  "mget",
  "mset",
  "blob_store",
  "blob_load",
  "some",
  "none",
  "is_some_opt",
  "unwrap",
  "sha256",
  "keccak256",
  "is_address",
  "assert_address",
  "sum",
  "fhe_load_pk",
  "fhe_deser",
  "fhe_ser",
  "fhe_add",
  "fhe_sub",
  "fhe_mul",
  "fhe_scale",
  "fhe_add_const",
  "fhe_sub_const",
  "fhe_verify_zero",
  "fhe_verify_range",
  "fhe_verify_bound",
  "fhe_commit",
  "fhe_pedersen",
]);

const OASM_OPCODES = new Set([
  "PUSH",
  "POP",
  "DUP",
  "SWAP",
  "ADD",
  "SUB",
  "MUL",
  "DIV",
  "MOD",
  "AND",
  "OR",
  "XOR",
  "NOT",
  "EQ",
  "LT",
  "GT",
  "CALL",
  "RETURN",
  "JUMP",
  "JUMPI",
  "STORE",
  "LOAD",
  "HALT",
]);

function tokenString(stream: StringStream): string {
  let escaped = false;
  let ch: string | void;
  while ((ch = stream.next()) != null) {
    if (ch === '"' && !escaped) break;
    escaped = !escaped && ch === "\\";
  }
  return "string";
}

export const amlLanguage = StreamLanguage.define({
  name: "aml",
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match('"')) return tokenString(stream);
    if (stream.match(/^\d[\d_]*/)) return "number";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      if (AML_KEYWORDS.has(word)) return "keyword";
      if (AML_TYPES.has(word)) return "typeName";
      if (AML_BUILTINS.has(word)) return "builtin";
      if (stream.peek() === "(") return "function";
      return "variableName";
    }
    if (stream.match(/^[{}[\]()]/)) return "bracket";
    if (stream.match(/^[+\-*/%=<>!&|.,:;]+/)) return "operator";
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "//" },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
  },
});

export const oasmLanguage = StreamLanguage.define({
  name: "oasm",
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("//") || stream.match(";")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^\d[\d_]*/)) return "number";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*:/)) return "labelName";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      return OASM_OPCODES.has(stream.current().toUpperCase()) ? "keyword" : "variableName";
    }
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: ";" },
  },
});

const completion = (label: string, type: string, detail?: string): Completion => ({
  label,
  type,
  detail,
});

export const AML_COMPLETIONS: Completion[] = [
  ...[...AML_KEYWORDS].map((k) => completion(k, "keyword")),
  ...[...AML_TYPES].map((t) => completion(t, "type")),
  completion("Program", "keyword", "Program Name { ... } - the file wrapper"),
  completion("len", "function", "len(s)"),
  completion("require", "function", "require(cond, msg)"),
  completion("call", "function", 'call(contract, "method", args...)'),
  completion("transfer", "function", "transfer(to, amount)"),
  completion("to_string", "function", "to_string(value)"),
  completion("concat", "function", "concat(s1, s2)"),
  completion("parse_ints", "function", "parse_ints(csv, base_addr)"),
  completion("mget", "function", "mget(addr)"),
  completion("checkpoint", "function", "transactional state"),
  completion("rollback", "function", "transactional state"),
  completion("commit", "function", "transactional state"),
  completion("caller", "variable", "tx sender"),
  completion("self_addr", "variable", "contract address"),
  completion("origin", "variable", "tx origin"),
  completion("value", "variable", "native OCT sent"),
  completion("epoch", "variable", "current block"),
  completion("fhe_load_pk", "function", "fhe_load_pk(addr)"),
  completion("fhe_deser", "function", "fhe_deser(ct_string)"),
  completion("fhe_ser", "function", "fhe_ser(ct)"),
  completion("fhe_add", "function", "fhe_add(pk, ct1, ct2)"),
  completion("fhe_sub", "function", "fhe_sub(pk, ct1, ct2)"),
  completion("fhe_scale", "function", "fhe_scale(pk, ct, scalar)"),
  completion("fhe_add_const", "function", "fhe_add_const(pk, ct, n)"),
  completion("fhe_verify_zero", "function", "fhe_verify_zero(pk, ct, proof)"),
];

export const OASM_COMPLETIONS: Completion[] = [...OASM_OPCODES].map((op) =>
  completion(op, "keyword"),
);

// Null = not enough signal (keep whatever language is already active).
export function detectContractLanguage(source: string): "aml" | "assembly" | null {
  if (
    /\b(Program\s+\w+|Contract\s+\w+|state\s*\{|view\s+fn|fn\s+\w+\s*\(|constructor\s*\(|struct\s+\w+|enum\s+\w+|emit\s+\w+|require\s*\(|invariant\s+\w+)/.test(
      source,
    )
  ) {
    return "aml";
  }
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(";") && !l.startsWith("//"));
  if (lines.length === 0) return null;
  let hits = 0;
  for (const l of lines) {
    if (/^[A-Za-z_]\w*:$/.test(l)) {
      hits++;
      continue;
    }
    const word = l.split(/\s+/)[0]?.toUpperCase();
    if (word && OASM_OPCODES.has(word)) hits++;
  }
  return hits / lines.length >= 0.6 ? "assembly" : null;
}
