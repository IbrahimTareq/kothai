---
layout: home

hero:
  text: Save now. Remember later.
  tagline: >-
    Everything you save gets read and filed by a model running on your own
    machine. Later you ask it questions in plain English, and it answers from
    your own stuff rather than the open web.
  image:
    src: /logo.png
    alt: Kothai
  actions:
    - theme: brand
      text: Self-host it
      link: /self-hosting
    - theme: alt
      text: How it works
      link: /architecture
    - theme: alt
      text: GitHub
      link: https://github.com/IbrahimTareq/kothai

features:
  - title: Self-hosting
    details: >-
      One container, no database server, no account, no API key. Docker,
      Compose, ONCE, Tailscale, and how to back the whole thing up.
    link: /self-hosting
    linkText: Get it running
  - title: Architecture
    details: >-
      How it is put together and why — the two-phase save, the enrich queue,
      the inference facade, delta sync, and the limits that are deliberate.
    link: /architecture
    linkText: Read the design
  - title: Models & inference
    details: >-
      Three model roles, two providers, one facade. Presets, the RAM dial, the
      embedding recipe, and grammar-constrained classification.
    link: /models
    linkText: Pick your models
  - title: HTTP API
    details: >-
      Everything is JSON over one port, with no versioning prefix. Notes,
      spaces, ask, enrichment, import and export, and the error codes.
    link: /api
    linkText: Browse the endpoints
  - title: Security
    details: >-
      The threat model, the password gate, the SSRF guard, untrusted uploads,
      and an honest list of what is deliberately not protected.
    link: /security
    linkText: Understand the edges
  - title: Development
    details: >-
      Setup, the two ports, the commands you will actually use, how the test
      suite is laid out, and what CI enforces.
    link: /development
    linkText: Start contributing
---
