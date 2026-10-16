# Implementation plan

1. Review the design and plan before implementation. Route read-only review with
   model-router and resolve findings against concrete code and contracts.
2. Runtime slice: update model family/fallback and effort; meaningful argv and
   catalog regressions; bounded opt-in comparison runner using an isolated temporary workspace.
3. Range slice: introduce a coaching-only public-action estimator, expose its
   assumptions in facts, and test posterior sensitivity, unknown evidence and
   hidden/future-information invariance. Do not change policy/reference bytes.
4. Coaching slice: supply only validated prospective snapshots to the hand coach,
   maintain note publication/proof/recovery contracts, and add real prompt-capture
   invariance and legacy-missing-evidence checks. Test neighboring lifecycle code.
5. Learning slice: a source-safe next-step action and actionable coverage/help
   text using existing study APIs. Verify lifecycle/busy/recovery and source
   mismatch boundaries; exercise the actual rendered study page if changed.
6. Freeze the integrated diff for two routed independent code reviews. Fix accepted
   findings, rerun affected checks, and repeat within router review budgets.
7. Run full local CI and any bounded real-provider smoke/comparison. Document
   limitations, open PR, await all required CI, merge, and synchronize main safely.
8. Use official Deep Wiki transaction tooling, with source provenance and a final
   read-only lint/inspection. Report the merged PR and verified Wiki outcome.
