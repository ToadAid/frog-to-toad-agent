# Frog-to-Toad foundation import

This branch imports the known-good trading desk as the starting body for the
Frog-to-Toad autonomous-agent experiment.

- Target repository: `ToadAid/frog-to-toad-agent`
- Preserved pre-import parent: `64d166b1dae0647dc9df2253cd86653d877c31be`
- Donor repository: `ToadAid/trading-desk`
- Donor commit: `015b1cb8a860bef8a27761e376e51c7274539e92`
- Donor tree: `5fd8ef2a9732bdbd6eb090cc242089a947c3aad7`

The pre-import Frog-to-Toad Stage-0 governance history remains in Git history
at and before the preserved parent above.

This import intentionally makes **no autonomous-trading authority change**.
The donor's human approval path, DRY_RUN behavior, safety rails, signer
separation, limits, and fail-closed controls remain intact. Autonomous
operation is a separate reviewed cut.
