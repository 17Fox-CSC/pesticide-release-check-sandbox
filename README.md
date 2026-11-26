# Independent release check sandbox

This repository contains only synthetic data. It has no production deployment or Pages.

The trusted main workflow validates the GitHub test merge tree. Candidate code is never run. The application posts a commit status only on the verified test merge SHA.

The sandbox fixture is pre-registered at bootstrap. All later changes to trusted workflow and approval code require repository review. This sandbox cannot authorize production releases.

## Synthetic public mirror model

The verifier consumes GitHub's repository ID, PR number, current base, head,
and two-parent test merge. The release must descend from the pre-approval
base, and both the candidate diff and its effect on the merge may touch
only `data/`. Trusted control records are read as Git blobs from the
protected base. The candidate's workflow, checker and control files are never
executed or used as authority.

For a post-bootstrap synthetic test, first prepare a data-only candidate and
obtain its PR number and head SHA. On main, an independently reviewed
control-only registration commit would then contain:

- `control/release-registry.json`: schema, pre-approval base SHA, and SHA-256
  of the exact approval record bytes.
- `control/release-approval.json`: schema and synthetic scope, repository
  ID, PR number, candidate head, action, active version and both active pointer
  digests, both staged pointer digests, seven plain and seven gzip file digests
  per staged version, ordered version IDs, rollback target, and P0 evidence digest.
- `control/release-p0.json`: synthetic evidence scoped to the same repository,
  PR and action. The model accepts only `simulate-only`.

The registration binds the existing candidate head and its staged bytes.
The checker derives the registration commit and the test merge from GitHub,
so the approval record does not need to name its own commit or an unborn merge.
Only one immediate control-only registration commit is accepted. A new
candidate push or base commit makes the old recording inapplicable.
The existing bootstrap records remain historical and cannot authorize this
model. The synthetic dates and IDs are fixed deliberately.

The first release must be one version `[A]` with no rollback. Advance requires
`[A,B]` with byte-identical A, fixed business metadata, and exactly one new
issue. The seven-file contract verifies gzip hashes and decompressed bytes.
The approval binds the public latest-price output, which excludes
`supplyNote`, `breadth`, and each quote's `note`. The synthetic model has no
publication operation.

Run the offline suite with:

```sh
node --test control/*.test.mjs
```

## Service-side acceptance after trusted installation

Keep `independent-sandbox-release`. The sandbox Ruleset already binds this
context to App 5896859, and renaming it would require synchronized rule and
signing changes. This change does not add a candidate-workflow status or
change the trusted signing job.

Before running these steps, separately approve a safe onboarding of the new
checker to protected sandbox main. The active checker on main only accepts a
data-only candidate and cannot sign its own code upgrade PR. Do not dispatch
candidate code with the App key or satisfy the review requirement with an
untrusted status.

For a synthetic PR with a trusted registration, record the GitHub API base,
head, test merge, App status, and applicable Rule Suite. Verify the App
status is restricted to that test merge. Push the candidate, advance main,
change or omit the approved record in a controlled fixture, and withhold
the signer or induce a scoped failed run. In each case, confirm GitHub cannot
accept the old success as approval for the currently eligible revision.
Where a ref update is used to isolate the status rule, use only dedicated
synthetic refs with separate authorization. Compare same-name statuses from
ordinary Actions and from a user against the App-bound result. Never infer
source rejection solely from missing PR reviews. These service-side checks
require later authorization and are not part of this offline development PR.
