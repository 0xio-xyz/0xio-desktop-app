import { afterEach, describe, expect, it } from "vitest";
import { loadContracts } from "src/features/contracts/hooks/useContractRegistry";
import { normalizeAbi } from "src/services/contracts/contractAbi";

const COMPILED =
  '{"declaration":"contract","constructor":{"name":"constructor","inputs":[],"input_names":[],"output":"void","view":false,"payable":true},"functions":[{"name":"increment","inputs":["int"],"input_names":["by"],"output":"void","view":false,"payable":false},{"name":"get_count","inputs":[],"input_names":[],"output":"int","view":true,"payable":false}],"events":[]}';

const FROM_NODE = {
  address: "oct7qu3gvyqFwsPRN1ZnDM1wMtWqkwMgVccsTyn88vGo98R",
  methods: [
    { name: "decimals", view: true },
    { name: "receive_oct", view: false },
  ],
  instruction_count: 402,
};

const COUNTER = [
  { name: "increment", params: [{ name: "by", type: "int" }], returns: "void", mutates: true },
  { name: "get_count", params: [], returns: "int", mutates: false },
];

describe("normalizeAbi", () => {
  it("reads the compiler's JSON string", () => {
    expect(normalizeAbi(COMPILED)).toEqual(COUNTER);
    expect(normalizeAbi(JSON.parse(COMPILED))).toEqual(COUNTER);
  });

  it("reads the node's method list", () => {
    expect(normalizeAbi(FROM_NODE)).toEqual([
      { name: "decimals", params: [], mutates: false, typed: false },
      { name: "receive_oct", params: [], mutates: true, typed: false },
    ]);
  });

  it("reads an ABI nested under abi, as a string or an object", () => {
    expect(normalizeAbi({ address: "oct", abi: COMPILED })).toEqual(COUNTER);
    expect(
      normalizeAbi({ abi: { functions: [{ name: "f", inputs: ["u128"], view: true }] } }),
    ).toEqual([{ name: "f", params: [{ name: "arg0", type: "u128" }], mutates: false }]);
  });

  it("keeps a list that is already normal", () => {
    expect(normalizeAbi(COUNTER)).toEqual(COUNTER);
  });

  it("reads names only and drops entries without a name, and repeats", () => {
    expect(normalizeAbi({ methods: ["a", { name: "a" }, {}, null, 7, "", { name: "b" }] })).toEqual(
      [
        { name: "a", params: [], mutates: true, typed: false },
        { name: "b", params: [], mutates: true, typed: false },
      ],
    );
  });

  it("reads a names-only list saved before typed existed as untyped", () => {
    const saved = [
      { name: "register", params: [], mutates: false },
      { name: "get_count", params: [], returns: "int", mutates: false },
    ];
    expect(normalizeAbi(saved)).toEqual([
      { name: "register", params: [], mutates: false, typed: false },
      { name: "get_count", params: [], returns: "int", mutates: false },
    ]);
  });

  it("is an empty list for anything else", () => {
    for (const raw of [undefined, null, "", "not json", '"text"', 42, true, {}, { abi: null }])
      expect(normalizeAbi(raw)).toEqual([]);
  });
});

describe("loadContracts", () => {
  afterEach(() => localStorage.clear());

  it("turns a saved compiler string into a list", () => {
    const saved = { address: "oct1", name: "Counter", language: "aml", abi: COMPILED };
    localStorage.setItem("k", JSON.stringify([saved, { address: "oct2", name: "Plain" }]));
    const [first, second] = loadContracts("k");
    expect(first.abi).toEqual(COUNTER);
    expect(second).toEqual({ address: "oct2", name: "Plain" });
  });

  it("is empty when the save is not a list", () => {
    localStorage.setItem("k", '{"contracts":[]}');
    expect(loadContracts("k")).toEqual([]);
  });
});
