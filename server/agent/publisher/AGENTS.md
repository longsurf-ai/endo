# publisher

Owns the protocol-independent Agent change publication contract and its client
protocol implementations.

## Invariants

- `publisher.ts` exports `Publisher.Change`, `Publisher.Interface`, and
  `Publisher.Service`. Domain owners depend only on this contract; application
  runtime selects the implementation.
- Operations pass committed Message/Part/Session facts; Run and Permission
  owners pass their resulting snapshots. Callers resolve Publisher.Service and
  invoke publish directly.
- Permission supplies each receiving Session's complete approval view, including
  delegated descendants. The publisher routes it to that Session without deriving
  permission visibility or changing the requests' original Session IDs.
- Inputs are shared references. Implementations must not mutate them and own
  copying any data retained or queued beyond delivery.
- Delivery is awaited under the existing Events barrier, including any snapshot
  read. It cannot reacquire that barrier or wait for a client/model/approval.
  Failed writes publish nothing.
- The publisher owns no bus, durable log, replay, or additional execution state.
- `agui/` implements the contract and owns native projection, event encoding,
  and bootstrap. Protocol-specific bootstrap stays outside the publisher
  contract. See [agui/AGENTS.md](agui/AGENTS.md).
- `publisher.test.ts` verifies committed facts, failed-write suppression, and
  delivery ordering through domain operations with a protocol-free implementation.
