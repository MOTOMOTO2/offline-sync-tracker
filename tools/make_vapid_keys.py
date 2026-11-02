"""Print a new VAPID key pair for Web Push, as Tally's settings want them.

    python tools/make_vapid_keys.py

VAPID_PUBLIC_KEY goes to browsers; VAPID_PRIVATE_KEY signs every push and
must stay on the server. Making a new pair means every device has to turn
notifications on again.
"""

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


key = ec.generate_private_key(ec.SECP256R1())
private = key.private_numbers().private_value.to_bytes(32, "big")
public = key.public_key().public_bytes(
    serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
)
print(f"VAPID_PUBLIC_KEY={b64url(public)}")
print(f"VAPID_PRIVATE_KEY={b64url(private)}")
