# Security Policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private vulnerability reporting: open this repository's
**Security** tab and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and its impact. We will acknowledge
the report and keep you informed while it is fixed.

## Scope

- The `@scorbit/feed` library and the `scorbit-feed` agent in this repository.
- Credential handling in particular: an `sb_live_` API key or an `sbf_` feed
  token that could leak through a log line, an error, an agent response, or a
  browser code path is in scope.

Vulnerabilities in the Scorbit API or data feed service itself can be reported
through the same channel.
