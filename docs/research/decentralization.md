# Research brief — decentralization options

> Reference material for [PLAN.md](../PLAN.md) §6.5. Verified October 2026 from upstream docs.

## The core problem: these three things live at different layers

"Decentralized" is used for three unrelated architectures. Picking one is a question of *which layer* you want decentralized, not which project is better.

| Option | Layer | What it actually is | Fit for video + live + photos |
| --- | --- | --- | --- |
| **Fedify / ActivityPub** | Social graph & identity | TypeScript framework for federated servers; millions of accounts across thousands of independent servers | ✅ **Right layer.** Gives portable identity (`@you@yourdomain`), following, replies, interop with Mastodon/PeerTube/Lemmy |
| **Freenet** | P2P app/storage platform | "Services without servers": peers form a small-world ring; browser apps in Rust/TS/WASM; content is censorship-resistant and can't be taken down | ⚠️ Right spirit, wrong workload — no ABR, no live latency guarantees, no bandwidth guarantees; it's a parallel app runtime, not a web-facing media origin |
| **Reticulum** | Transport / mesh networking | Cryptographic mesh stack over LoRa/RNode, packet radio, serial, I2P, TCP/UDP | ❌ **Wrong layer entirely.** Designed for scarce bandwidth and high latency |

### Why Reticulum is not viable here

Its own manual has sections titled *"The Bandwidth Fallacy"*, *"Cost Of A Byte"*, and *"Merits Of Scarcity"*. It is explicitly built for low-bandwidth, high-latency, store-and-forward links — the interface list is LoRa, packet radio, KISS, AX.25. Its application ecosystem is text and messaging: Nomad Network (text pages), LXMF (messaging), LXST (telephony/voice), RRC (chat), git-over-Reticulum. There is no video path, and there cannot be a good one on a LoRa link.

Reticulum RNS 1.5.5 is an excellent piece of engineering for off-grid communication. It is simply not a substrate for a 1080p livestream. (Its license is also non-standard and has been publicly disputed — review it before depending on it for anything.)

### Why Freenet is not viable here

The current Freenet ("Locutus" rewrite, `freenet-core`, a 501(c)(3) founded 2001) is a peer-to-peer platform for apps no company controls — the flagship app is River, group chat. It's genuinely impressive and philosophically aligned. But for this project it fails on the workload:

- Media delivery goes through unpredictable peer routing, with no adaptive bitrate, no segment-level QoS, and no latency floor you can promise.
- Multi-GB video libraries and sub-second live video are precisely what it does not target.
- Your site would become a Freenet app running inside a Freenet peer rather than a website people open on the normal web. That trades away the "comfy premium website anyone can visit" requirement.

### Why Fedify is the right answer

Verified from [fedify.dev](https://fedify.dev/): Fedify is a TypeScript federation framework handling **ActivityPub, Activity Streams 2.0, HTTP Signatures (draft-cavage-12 and RFC 9421), WebFinger (RFC 7033), NodeInfo, Object Integrity Proofs (FEP-8b32), and Linked Data Signatures** behind type-safe APIs. It does the subtle, security-critical work (signatures, discovery, queued delivery with exponential backoff, two-stage fan-out) that is exactly where a hand-rolled implementation gets exploited.

Crucially, it **matches the stack this plan already chose**:

- **First-party Next.js integration**, plus Fastify/Hono/Express/Nuxt/SvelteKit/Astro/SolidStart.
- **PostgreSQL message queue and PostgreSQL KV store** — so federation adds *no new service*. It plugs into the same Postgres already running pg-boss.
- **It never owns your data model**: actors, posts, and followers stay in our schema, read through dispatcher callbacks we write.
- Interoperates with Mastodon, Misskey, Lemmy, Pleroma, and PeerTube.
- Ships **interaction controls** (useful for a broadcast-first posture), media upload, collections, relay, migration, testing, and OpenTelemetry support.

## The insight that makes this cheap: split the two axes

Decentralization here is **two independent problems**, and conflating them is why the question feels hard:

**Axis 1 — the social graph and identity → ActivityPub (Fedify).**
Solves "no platform owns my identity". Your instance *is* your identity: `@you@yourdomain`. Followers on Mastodon can follow you; your posts appear in their timelines; replies can come back. This is the genuinely popular, working fediverse — PeerTube, Pixelfed, Mastodon, Lemmy.

**Axis 2 — the media bytes → still needs a real origin, but P2P can offload it.**
ActivityPub federates *metadata and links*, never video bytes. This is confirmed by PeerTube's own documentation: it distributes video via **HLS with P2P over WebRTC** — "exchange parts of the video with other users watching the same video to save server bandwidth" — plus *instance redundancy* (other PeerTube servers mirroring your videos).

That second mechanism attacks the exact constraint documented in PLAN.md §7.3: **the uplink bandwidth ceiling on concurrent live/VOD viewers.** So P2P delivery is not ideological decoration here — it is the only mechanism in this whole design that raises the viewer ceiling without buying a datacenter uplink. Notably, PeerTube stores *two different files* if you enable both WebTorrent-style web video and HLS-with-P2P; pick HLS+P2P only, and expect to store one version.

**What neither axis fixes:** livestreaming. There is no working ActivityPub standard for real-time video, and P2P live (WebRTC mesh/swarm) is hard, lossy, and NAT-hostile. **Live stays origin-served on your box** — the honest position, and another argument for keeping live scope optional.

## What federation actually costs

Not free, and the costs are mostly non-technical:

- **A security-critical surface.** Signatures, JSON-LD parsing, spoofing (Fedify addresses this with an origin-based security model, FEP-fe34), and SSRF from dereferencing remote objects. This is the strongest argument for using Fedify rather than hand-rolling.
- **Moderation is the real tax.** The moment you *accept* inbound replies, you own moderating them. This is why the plan recommends **broadcast-first**: publish out, don't ingest a firehose. Fedify's interaction-controls module supports exactly this posture.
- **A permanent identity contract.** Federated IDs are URLs. You cannot renumber, restructure routes, or hard-delete without breaking every remote copy.
- **Deliverability is asynchronous and unreliable.** Queues, retries, dead instances. Fedify handles it; you still have to monitor it.

## Alternatives considered

- **Nostr** — the lightest social layer: identity is a keypair, you publish events to relays, **no server of your own is strictly required**. Closest to "decentralized with no server". But there's no mature video/live story, and you lose control of the presentation layer. Worth treating as a *second* output target later, not the foundation.
- **AT Protocol / Bluesky** — technically elegant (per-user repos, portable identity via PDS migration, global index), but self-hosting means running a PDS and dealing with relays/appviews. Much heavier for a personal site than an ActivityPub actor.
- **Bridging** — AP↔Nostr bridges exist, so choosing ActivityPub now does not foreclose Nostr later.

## Recommendation

1. **ActivityPub via Fedify** for identity and distribution. It fits the chosen stack with no new services.
2. **Broadcast-first, replies opt-in.** Push posts and let people follow you; do not accept inbound content in v1.
3. **P2P media delivery (HLS + WebRTC, PeerTube-style) as an optional bandwidth-offload mode** — the only lever that raises the viewer ceiling on a home uplink.
4. **Live stays origin-served and honest about its ceiling.**
5. **Design five seams in Phase 0** (see PLAN.md §6.5) so federation is a *feature flag plus an actor document*, not a rewrite. Implement in Phase 5.
6. **Freenet and Reticulum are out of scope** — not because they're poor projects, but because they operate at layers that cannot carry this workload.
