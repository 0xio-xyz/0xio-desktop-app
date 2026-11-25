// (Program wrapper, fn name(): type, require/emit/transfer/value builtins).

interface ContractTemplate {
  id: string;
  label: string;
  source: string;
}

export const CONTRACT_TEMPLATES: ContractTemplate[] = [
  {
    id: "empty",
    label: "Empty program",
    source: `Program MyProgram {
  state {
    owner: address
  }

  constructor() {
    self.owner = caller
  }
}
`,
  },
  {
    id: "counter",
    label: "Counter",
    source: `Program Counter {
  state {
    count: int
    owner: address
  }

  event Incremented(by: address, value: int)

  constructor() {
    self.count = 0
    self.owner = caller
  }

  fn increment() {
    self.count = self.count + 1
    emit Incremented(caller, self.count)
  }

  view fn get_count(): int {
    return self.count
  }
}
`,
  },
  {
    id: "token",
    label: "Simple token",
    source: `Program SimpleToken {
  state {
    name: string
    symbol: string
    total_supply: u128
    owner: address
    balances: map[address]u128
  }

  event Transfer(from: address, to: address, amount: u128)

  constructor(n: string, s: string, supply: u128) {
    require(len(n) > 0, "name empty")
    require(len(s) > 0, "symbol empty")
    require(supply > 0, "supply must be positive")
    self.name = n
    self.symbol = s
    self.total_supply = supply
    self.owner = origin
    self.balances[origin] = supply
    emit Transfer(origin, origin, supply)
  }

  fn transfer_token(to: address, amount: u128) {
    require(amount > 0, "amount must be positive")
    require(self.balances[caller] >= amount, "insufficient balance")
    self.balances[caller] = self.balances[caller] - amount
    self.balances[to] = self.balances[to] + amount
    emit Transfer(caller, to, amount)
  }

  view fn balance_of(who: address): u128 {
    return self.balances[who]
  }
}
`,
  },
  {
    id: "escrow",
    label: "Escrow",
    source: `Program Escrow {
  state {
    depositor: address
    beneficiary: address
    arbiter: address
    amount: int
    released: bool
  }

  event Deposited(from: address, amount: int)
  event Released(to: address, amount: int)

  constructor(beneficiary: address, arbiter: address) {
    self.depositor = caller
    self.beneficiary = beneficiary
    self.arbiter = arbiter
    self.amount = 0
    self.released = false
  }

  payable fn deposit() {
    require(caller == self.depositor, "only depositor")
    require(value > 0, "send OCT with the call")
    require(self.released == false, "already released")
    self.amount = self.amount + value
    emit Deposited(caller, value)
  }

  nonreentrant fn release() {
    require(caller == self.arbiter, "only arbiter")
    require(self.released == false, "already released")
    require(self.amount > 0, "nothing to release")
    self.released = true
    let ok = transfer(self.beneficiary, self.amount)
    require(ok, "transfer failed")
    emit Released(self.beneficiary, self.amount)
  }
}
`,
  },
];
