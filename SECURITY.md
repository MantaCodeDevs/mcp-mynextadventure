# Security policy

## Reporting a vulnerability

Please report security issues privately, not in public issues:

- **GitHub:** [Report a vulnerability](https://github.com/MantaCodeDevs/mcp-mynextadventure/security/advisories/new) (private vulnerability reporting is enabled on this repository), or
- **Email:** akos.orban@mantacode.com

We aim to acknowledge reports within 3 working days and to keep you updated until a fix is deployed. This repository mirrors the server that runs at `https://mcp.mynextadventure.cloud/mcp`, so fixes ship to the hosted server as well. Please give us a reasonable chance to fix an issue before disclosing it publicly.

## Acknowledgments

We thank the following people for responsibly disclosing security issues:

- **Syed Anas Mohiuddin**, Independent Researcher: reported a session credential-binding issue in the server's MCP transport handling (September 2026). It was fixed by binding every request to the credential that created its session, and then retired entirely by moving to a stateless handler.
