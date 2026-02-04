# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately.

**Do not open a public issue for security vulnerabilities.**

### How to Report

Send an email with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- Initial response: within 48 hours
- Status update: within 7 days
- Fix timeline: depends on severity

### Scope

This policy applies to:

- All packages in the `@orijs/*` namespace
- The OriJS framework core

### Out of Scope

- Vulnerabilities in dependencies (report to upstream)
- Issues requiring physical access
- Social engineering attacks

## Security Best Practices

When using OriJS:

- Keep dependencies updated
- Use TypeBox validation for all inputs
- Never expose internal errors to clients
- Use parameterized queries for database access
- Store secrets in environment variables
