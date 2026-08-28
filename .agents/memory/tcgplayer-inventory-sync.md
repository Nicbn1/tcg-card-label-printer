---
name: TCGplayer inventory sync
description: Decision and constraints for getting PriceTag inventory into TCGplayer.
---

Use TCGplayer Seller Portal pricing CSVs as a round-trip: import an existing Live inventory export, retain its TCGplayer IDs and listing fields, edit `Add to Quantity`, and export the full file back for the Seller Portal.

**Why:** The app's PriceCharting identifiers are not TCGplayer identifiers, and TCGplayer says it is not granting new API access. Updating only `Add to Quantity` avoids corrupting prices, conditions, and metadata that TCGplayer needs to identify listings.

**How to apply:** Treat automatic matching as a quantity suggestion only. Users should review every suggested quantity against the existing TCGplayer listing and condition before importing the exported file to Staged Inventory.

Automatic mappings must require trustworthy name, set, and condition agreement. Weaker matches stay in a review queue, and a staff-selected label-to-listing mapping becomes the durable target for later exports. Manual quantity edits must survive suggestion refreshes as explicit overrides.

**Why:** Product names and IDs can span multiple sets or condition rows. Resetting staff edits or accepting a weaker match can silently add stock to the wrong Seller Portal listing.

**How to apply:** Recompute suggestions from active labels immediately before export, keep unresolved labels at zero, and block export until their listing targets are confirmed.