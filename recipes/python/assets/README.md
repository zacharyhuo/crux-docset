# Python docset icons

`python-logo-only.png` is the original image explicitly selected by the user.
`icon.png` (16×16) and `icon@2x.png` (32×32) are proportional reductions,
centered on transparent square canvases. The shape, colors and shadow are retained.

- Source: https://s3.dualstack.us-east-2.amazonaws.com/pythondotorg-assets/media/community/logos/python-logo-only.png
- Original dimensions: 269×326.
- Original SHA-256: `4008a934b415c152bfa513be3e9b05de4212ae41549a27f2c6c8d41b3a24a4da`.
- Preparation: macOS `sips -Z 16` / `sips -Z 32`, then `pngjs` transparent
  square canvas and centered `bitblt`. This is a one-time asset preparation;
  normal builds require neither macOS nor a network download for icons.

Python and the Python logos are trademarks or registered trademarks of the
Python Software Foundation. These icons identify Python documentation, not
Crux itself, and do not imply PSF sponsorship or endorsement. They are not
relicensed under Crux's code license.

Review the [official logo guidance](https://www.python.org/community/logos/)
and [PSF trademark policy](https://www.python.org/psf/trademarks/) before public
distribution or changing the artwork. Document licensing and trademark rules
are separate; this note does not assert a separate permission grant.

Builds read these checked-in PNGs offline. Replacing either image changes the
builder fingerprint. Keep both names/sizes; validation requires decodable PNGs
with valid CRCs, bounded bytes and the expected dimensions.

## Verification (2026-09-22)

- `npm test`: 55/55 passed (includes missing, wrong-size, CRC-corrupt icons,
  source symlink rejection and image-content fingerprint changes).
- Rebuilt the cached Python 3.14.7 archive: 572 pages, 16,880 symbols;
  validation passed without warnings. Both packaged PNG hashes match the recipe assets.
- Candidate: `.work/python-icons/releases/57bb54f79075f3da9cb28c182e348d4991b892836d5d1b43bd415b2e75c829d0/`.
- Imported into Crux Beta. Screenshots confirmed the double-snake icon in the
  Installed list and the reader's Python search-scope control.
- Production Crux and client source untouched. No remote publication.
