# Reverse proxy IP configuration

The `/auth/callback` and `/access` login audit events store Express's `req.ip`.
Express proxy trust is disabled by default, so without configuration `req.ip`
is the direct network peer (which may be the reverse proxy's internal Docker
address).

## Configure only after verifying the VPS

Set `TRUSTED_PROXY_IPS` in the WEB service environment to a comma-separated
list of the reverse proxy's exact source IP address(es), or the narrowest
CIDR range(s) that contain them, as seen by the WEB container. Express trusts
forwarded addresses only when the direct peer matches one of these entries.
Invalid entries prevent the application from starting. An empty value keeps
proxy trust disabled.

This WEB repository does not contain the VPS deployment, reverse-proxy, or
Docker network configuration, and no production proxy IP/CIDR can be verified
from it. Do not copy an assumed/example address into production.

Before setting `TRUSTED_PROXY_IPS`, the VPS administrator must:

1. Inspect the active VPS reverse-proxy and container/network configuration to
   verify the source IP or narrow subnet that the WEB process actually sees.
   Do not use the proxy's public address unless that is the observed connection
   source.
2. Ensure the WEB listener is reachable only from the intended proxy/network;
   a client able to connect from a trusted source could otherwise supply its
   own forwarded header.
3. Verify the proxy removes or replaces client-supplied `X-Forwarded-For` with
   the actual connecting client address (and maintains a correct chain if
   there are multiple proxy hops). Trust only the proxy hops in that chain.
4. Set the smallest verified IP/CIDR list, restart the WEB service, and confirm
   a new login audit event records the client IP. If these checks cannot be
   completed, leave the setting blank; events will continue to record the
   direct peer address rather than trusting an unverified header.

Never configure `TRUSTED_PROXY_IPS` as `true`, `*`, a hop count, or a broad
network chosen without verification. The setting accepts only explicit IP
addresses and CIDR ranges.

Existing audit rows are not rewritten: historical IP addresses cannot be
recovered or corrected by this change. The correct client IP will appear only
in new login audit events after the proxy forwarding behavior and trusted
addresses have been verified and configured.
