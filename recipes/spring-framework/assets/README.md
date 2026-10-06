# Spring Framework docset icons

Official Spring website favicon, selected by the project owner on 2026-10-04.
These assets identify the documentation; they are not Crux branding and do not
imply endorsement or affiliation.

- Source: https://spring.io/favicon-32x32.png
- Official page declaring that asset: https://spring.io/
- `icon@2x.png`: original 32×32 PNG, unchanged.
- `icon.png`: 16×16 size conversion of the original; no logo redesign.
- Original/32×32 SHA-256: `d999cc0d9d461f8358f08f0cc69a7ddb43b533becb8f6d7901ce8ed473589ecc`.
- 16×16 SHA-256: `6c772fa5c56a58d65eba6d2d5b407349ffbd8b0bf61af7e3f0045facb5f5ddd6`.
- One-time conversion: macOS `sips --resampleHeightWidth 16 16 icon@2x.png --out icon.png`.
- Builds read both files locally through the existing recipe icon loader;
  no runtime download or external image generator is required.

Spring is a trademark of Broadcom Inc. and/or its subsidiaries. The logo is
not relicensed under this repository's code license. The owner explicitly
approved using the official icon for ongoing development; trademark review
remains a pre-publication record, not a blocker for local implementation.
See https://spring.io/trademarks/ . This note is not a permission grant.

The recipe remains disabled until the separate supply qualification work is
complete. Adding icons does not enable automatic builds or publication.
