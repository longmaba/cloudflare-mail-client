# Upstream and release provenance

This fork starts from [Doota](https://github.com/etherCorps/doota), pinned to
`100c1629fa5bce002653d019b2c95dfae54f942f`. Its Apache-2.0 LICENSE,
copyright notices and original commit history are preserved. Internal workspace
package names remain `@doota/*` to minimize changes to the existing implementation.

The original architecture supplies the Svelte mail client, Better Auth, D1,
encrypted R2 message storage, queue workers, search and infrastructure stack.
This fork adds portable guided setup, durable instance configuration, private
domain accounts, scoped pilot routing, incoming recovery and outgoing size
enforcement. New release instructions live in the repository root README and
OPERATIONS.md. Other inherited documentation describes upstream features and
must not be read as evidence of this fork's deployment acceptance.
