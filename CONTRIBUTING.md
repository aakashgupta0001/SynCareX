# Contributing

## Development principles

- Keep clinical records local-first once offline persistence is implemented.
- Never silently discard an operation or overwrite a concurrent clinical change.
- Keep extracted content linked to its source and require human review.
- Use synthetic data only. Do not add patient information, credentials, or `.env` files.
- Report unavailable AI models and device capabilities explicitly.
- Add focused tests for behavior and failure cases with every feature.

## Before submitting changes

- Run the smallest relevant test suite and type/lint checks.
- Document any change to synchronization, schema, security, or API contracts.
- Do not claim production readiness without deployment-grade security and operational validation.

## Current development setup

See [README.md](./README.md) for required tools and setup. The current scaffold has not yet been built or tested because Node.js is not installed, and backend dependencies are not installed.
