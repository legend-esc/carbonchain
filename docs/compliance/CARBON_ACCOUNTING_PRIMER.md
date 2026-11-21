# Carbon Accounting Primer

A reference for developers and integrators working with CarbonChain. This document covers the vocabulary, standards, and regulatory concepts that underpin the system's design decisions.

---

## Table of Contents

1. [Carbon Credit Fundamentals](#1-carbon-credit-fundamentals)
2. [The 1 Tonne = 1,000,000 Units Convention](#2-the-1-tonne--1000000-units-convention)
3. [Carbon Credit Vintages](#3-carbon-credit-vintages)
4. [Supported Standards and Registries](#4-supported-standards-and-registries)
5. [ICVCM Core Carbon Principles](#5-icvcm-core-carbon-principles)
6. [Article 6 of the Paris Agreement and Corresponding Adjustments](#6-article-6-of-the-paris-agreement-and-corresponding-adjustments)
7. [Glossary](#7-glossary)

---

## 1. Carbon Credit Fundamentals

### What is a Carbon Credit?

A carbon credit represents the verified removal or avoidance of one metric tonne of carbon dioxide equivalent (CO₂e) from the atmosphere. Credits are issued by recognized standards bodies after independent auditing and can be traded, held, or permanently retired to offset an organization's reported emissions.

The critical word is *verified*: a credit is not a promise but an audited outcome, documented with measurement data, methodology references, and third-party sign-off.

### Removal vs. Avoidance Credits

Credits divide into two broad categories depending on how the tonne is accounted for.

**Removal credits** represent carbon physically extracted from the atmosphere and stored:

- **Forestry / Afforestation, Reforestation, and Revegetation (ARR):** Trees grown on previously degraded land sequester CO₂ in biomass and soil. The sequestration is measured over time and credited as it accumulates.
- **Direct Air Carbon Capture and Storage (DACCS):** Industrial equipment strips CO₂ from ambient air and injects it into geological storage. Removal is permanent and highly measurable, which typically earns a price premium.

**Avoidance credits** represent emissions that did not occur because a project changed an activity:

- **Cookstoves:** Distributing efficient cookstoves in developing regions reduces the wood or charcoal burned per meal, cutting both CO₂ and black carbon emissions.
- **Renewable energy:** Solar or wind generation displacing coal-fired grid power avoids the emissions that would have come from burning that coal.
- **REDD+ (Reducing Emissions from Deforestation and Forest Degradation):** Projects protecting standing forests from clearing avoid the CO₂ that would have been released if those trees were felled.

Buyers sometimes distinguish removal from avoidance because removal addresses the existing atmospheric stock of CO₂ while avoidance only slows new additions to it. Many corporate net-zero commitments now require a minimum proportion of removal credits.

### Additionality

A project is **additional** if the carbon benefit would not have occurred in the absence of carbon credit revenue. Additionality is the most contested concept in carbon markets because it requires a counterfactual: what *would have* happened?

Verification bodies assess additionality through financial tests (would the project be profitable without credit revenue?), barrier tests (are there regulatory, technical, or social obstacles the carbon finance removes?), and common-practice tests (is the activity already widespread in the region, suggesting it happens regardless?).

A non-additional credit is effectively fictional — it retires against emissions that were never reduced. CarbonChain enforces additionality at the protocol level by requiring verifier attestations before credits are minted; see [Section 5](#5-icvcm-core-carbon-principles) for how this maps to the ICVCM Core Carbon Principles.

### Permanence and the Buffer Pool

Removal credits carry a permanence risk: a forest can burn, die from disease, or be cleared illegally after the credits have been sold. If the sequestered carbon re-enters the atmosphere, the credit's claim is invalidated.

Standards address this through **buffer pools** (also called insurance pools or risk buffers). When credits are issued, a portion — typically 10–20% of each project's credits, calibrated to a risk assessment — is set aside in a pooled reserve. If a project reverses (a wildfire, for example), credits are cancelled from the buffer pool rather than from buyers' accounts. The pool is funded collectively so that individual project failures do not automatically void already-retired credits.

Avoidance credits have an analogous permanence concern: if a protected forest project loses its funding or its legal protection, deforestation may resume. Buffer contributions apply here too.

### Leakage

Leakage occurs when an emission-reduction activity in one area displaces the emissions to another area. A REDD+ project protecting one forest patch may push loggers to an adjacent unprotected patch — the net atmospheric benefit is less than the credit volume suggests.

Standards require projects to monitor and discount for leakage. Leakage is classified as:

- **Activity shifting (direct leakage):** The same actors move their activities to a new location.
- **Market leakage:** Reduced supply of a commodity (timber, agricultural land) raises prices elsewhere, stimulating supply from non-project areas.

A leakage discount is applied to the gross emission reductions before credits are issued. Well-designed methodologies specify the monitoring approach and discount factors required.

---

## 2. The 1 Tonne = 1,000,000 Units Convention

### Why Integer Scaling?

Smart contract runtimes, including Soroban on Stellar, do not use floating-point arithmetic. All numeric values in the contract are integers. Carbon quantities naturally involve fractional tonnes — a small forestry plot might sequester 1.375 tonnes in a given period — so a direct integer representation in whole tonnes would lose precision.

CarbonChain solves this by scaling: **1 metric tonne CO₂e = 1,000,000 internal units**. This provides six decimal places of precision, sufficient for any practical carbon accounting purpose. Quantities are stored as `i128` in the Soroban runtime.

The choice of 1,000,000 (10⁶) mirrors the convention used in many financial token systems (e.g., 6-decimal ERC-20 tokens), making the pattern familiar to blockchain developers.

### Conversion Table

| Tonnes CO₂e | Internal Units |
|-------------|----------------|
| 0.000001    | 1              |
| 0.001       | 1,000          |
| 0.1         | 100,000        |
| 0.5         | 500,000        |
| 1           | 1,000,000      |
| 10          | 10,000,000     |
| 100         | 100,000,000    |
| 1,000       | 1,000,000,000  |
| 1,000,000   | 1,000,000,000,000 |

**Formula:**
```
units = tonnes × 1,000,000
tonnes = units ÷ 1,000,000
```

### Handling Fractional Tonnes in API Calls

JavaScript's `number` type is a 64-bit float with 53 bits of integer precision, giving a safe integer maximum of 9,007,199,254,740,991 (about 9 × 10¹⁵). A portfolio of one billion tonnes would be represented as 10¹⁵ units — within range but close enough to the boundary that arithmetic errors are plausible.

To avoid this, the CarbonChain API accepts and returns large unit quantities as **decimal strings**:

```json
{
  "projectId": "VCS-1234",
  "tonnesSequestered": "500000"
}
```

Here `"500000"` is a string representing 500,000 units, which equals 0.5 tonnes. Never deserialize this field as a JavaScript `number` before sending it to the API or storing it in a database that uses floating-point columns.

When displaying quantities to end users, convert server-side or use a BigInt library:

```typescript
// Correct: use BigInt for arithmetic, then format for display
const units = BigInt("500000");
const tonnes = Number(units) / 1_000_000; // 0.5 — safe here because we divide first
const display = tonnes.toFixed(6);        // "0.500000"
```

### i128 Range in Soroban

The `i128` type holds values from −(2¹²⁷) to 2¹²⁷ − 1, approximately ±1.7 × 10³⁸. At 10⁶ units per tonne, the maximum representable quantity is roughly **170 × 10³⁰ tonnes** — many orders of magnitude larger than any conceivable real-world carbon accounting requirement (global annual emissions are approximately 5 × 10¹⁰ tonnes CO₂e). Overflow in the tonnes field is not a practical concern.

---

## 3. Carbon Credit Vintages

### What is a Vintage?

The **vintage year** of a carbon credit is the calendar year in which the emission reduction or removal occurred. A forestry project that sequestered carbon between January and December 2022 would issue credits with a 2022 vintage.

Vintage is distinct from the issuance date. A project may submit its monitoring report months or years after the activity period closes, so credits with a 2022 vintage might not be issued until 2024.

### Why Vintage Matters

**Pricing:** Older vintages typically trade at a discount. The market interprets an older credit as more likely to have a defect that went undetected, and buyers with net-zero commitments often want recent vintage to demonstrate that their offsetting is concurrent with their emissions.

**Buyer requirements:** Many corporate sustainability frameworks and voluntary commitments impose a maximum vintage age. A common rule is that credits must be from the five most recent completed years; some buyers restrict to three years.

**Regulatory contexts:** Some compliance markets (e.g., California's Cap-and-Trade program) place hard limits on vintage age. Credits outside the allowed range cannot be used for compliance surrender, only for voluntary purposes.

**Stockpiling risk:** Large volumes of old-vintage credits entering the market can suppress prices and dilute the environmental signal. Registries and standard bodies sometimes apply vintage restrictions to prevent this.

### Vintage in CarbonChain

CarbonChain records the vintage year in the credit struct alongside the project ID and methodology reference. The registry enforces that the vintage year is not in the future and that it falls within the project's crediting period as declared at validation.

When querying credits, callers can filter by vintage range to meet buyer requirements. The API exposes `vintageFrom` and `vintageTo` query parameters for this purpose.

---

## 4. Supported Standards and Registries

CarbonChain supports credits originated under three major standard frameworks. Each framework defines its own methodology library, registry infrastructure, and serialization conventions.

### Verra VCS (Verified Carbon Standard)

**Governance:** Verra, a non-profit organization headquartered in Washington, DC. Verra operates the Verra Registry (formerly the APX registry) and publishes the VCS Program rules.

**Credit unit:** Verified Carbon Unit (VCU). One VCU represents one tonne CO₂e reduced or removed.

**Serial number format:**

```
[CountryCode]-[Methodology]-[ProjectID]-[Vintage]-[SerialNumber]
```

Example: `BR-VM0007-1360-2021-00000001` — a Brazilian REDD+ project (methodology VM0007), project ID 1360, 2022 vintage, first serial.

**Key methodologies:**

| Code   | Description                                               |
|--------|-----------------------------------------------------------|
| VM0007 | REDD+ Methodology Framework (avoided deforestation)       |
| VM0042 | Methodology for Improved Cook Stoves and Kitchen Regimes  |
| VM0048 | Afforestation, Reforestation, and Revegetation (ARR)      |

**Double-counting prevention:** When a VCU is used to offset emissions, it must be retired in the Verra Registry. CarbonChain treats the Verra retirement record as the authoritative signal and mirrors this status on-chain: a credit retired externally must be marked retired in CarbonChain too. Credits in an `active` state in CarbonChain but retired in the Verra Registry represent an inconsistency that the reconciliation process flags for operator review.

### Gold Standard

**Governance:** Gold Standard Foundation, a non-profit headquartered in Geneva, Switzerland. Gold Standard operates the Gold Standard Impact Registry.

**Credit units:** Verified Emission Reduction (VER) for projects developed under the Gold Standard for the Global Goals framework; historically also called Gold Standard VER (GS VER).

**Distinguishing focus:** Gold Standard places explicit emphasis on sustainable development co-benefits aligned with the UN Sustainable Development Goals (SDGs). Every Gold Standard project must demonstrate positive impacts beyond the carbon outcome — typically in SDG 7 (affordable and clean energy), SDG 3 (good health), or SDG 6 (clean water). These co-benefits are recorded as Sustainable Development Impact claims in the registry and can be reported alongside the carbon claim.

**Methodology examples:**

| Code        | Description                                              |
|-------------|----------------------------------------------------------|
| GS TPDDTEC  | Technologies and Practices to Displace Decentralized Thermal Energy Consumption (cookstoves/water purification) |
| GS GESRP    | Grid-connected renewable energy generation               |

### CDM (Clean Development Mechanism)

**Governance:** The CDM is supervised by the UNFCCC CDM Executive Board under the Kyoto Protocol.

**Credit unit:** Certified Emission Reduction (CER). One CER represents one tonne CO₂e.

**Context:** The CDM was the world's first large-scale international carbon crediting mechanism, established under the Kyoto Protocol to allow developed countries (Annex I parties) to invest in emission-reduction projects in developing countries. It generated hundreds of millions of CERs between 2001 and the mid-2010s.

**Article 6.4 as successor:** Under the Paris Agreement, Article 6.4 establishes a new UNFCCC-supervised crediting mechanism intended to replace the CDM. Article 6.4 Emission Reductions (A6.4ERs) are the successor credit unit. The transition is ongoing; the Article 6.4 Supervisory Body published its first methodology decisions in 2024.

**Legacy portfolio support:** Most active CDM projects have wound down, but large institutional portfolios hold historical CERs that must be tracked for retirement and reporting purposes. CarbonChain supports CDM credits specifically to allow retirement tracking of these legacy holdings. New issuance under CDM is not expected; the system treats CDM as a read-and-retire standard rather than an issuance pathway.

---

## 5. ICVCM Core Carbon Principles

### About the ICVCM

The **Integrity Council for the Voluntary Carbon Market (ICVCM)** is an independent governance body established in 2021 to set a threshold standard of integrity for voluntary carbon credits. The ICVCM's **Core Carbon Principles (CCPs)** define the minimum requirements a crediting program must meet for its credits to be labelled CCP-approved — a signal intended to identify high-quality credits in an otherwise fragmented market.

The CCPs are organized into three categories: governance, emissions impact, and sustainable development. As of 2024, the ICVCM has assessed several major programs, including Verra VCS and Gold Standard, against the CCPs.

### The Ten Core Carbon Principles

#### Governance

**1. Effective governance**
The crediting program must have clear governance structures, documented rules, and accountability mechanisms. Conflicts of interest must be managed, and decision-making must be transparent.

**2. Tracking**
Credits must be uniquely identified and tracked through issuance, transfer, and retirement in a registry that prevents double issuance and double claiming.

**3. Transparency**
Project documentation, methodology rules, verification reports, and credit issuance data must be publicly available. This enables independent scrutiny.

**4. Robust independent third-party validation and verification**
Projects must be validated before implementation and verified after each monitoring period by accredited Validation and Verification Bodies (VVBs) that are independent of the project developer.

#### Emissions Impact

**5. Additionality**
Credits must represent emission reductions or removals that are additional — they would not have occurred without the revenue from carbon credit sales.

**6. Permanence**
Emission reductions and removals must be permanent or, where reversal risk exists, must be covered by robust mitigation measures such as buffer pools and long-term monitoring obligations.

**7. Robust quantification of emission reductions and removals**
Methodologies must use conservative baselines, appropriate accounting boundaries, and uncertainty adjustments so that the tonnes represented by a credit are not overstated.

**8. No double counting**
A tonne of emission reduction or removal must only be counted once. This requires preventing double issuance (the same tonne backing two credits), double claiming (the same credit used to offset two separate entities' emissions), and double use at the sovereign level (addressed by corresponding adjustments under Article 6).

#### Sustainable Development

**9. Sustainable development benefits and safeguards**
Projects must protect against negative social and environmental impacts and, where possible, deliver positive co-benefits for local communities, biodiversity, and ecosystems.

**10. Contribution to net zero transition**
Credits must support, not undermine, the global transition to net zero emissions. This means avoiding credits that simply slow the rate of emissions increases rather than contributing to absolute reductions, and ensuring that crediting does not create disincentives for host-country policy action.

### CarbonChain's Programmatic Enforcement

CarbonChain enforces several CCPs directly through protocol rules rather than relying solely on off-chain audits:

| CCP | Enforcement mechanism in CarbonChain |
|-----|--------------------------------------|
| **Tracking (CCP 2)** | Every credit has a unique on-chain ID. The ledger is append-only; transfers and retirements are immutable records. Double issuance is prevented by the mint logic, which checks for ID uniqueness before creating a credit. |
| **Additionality (CCP 5)** | Credits cannot be minted without a verifier attestation. The MRV oracle contract records attestations from approved verifier nodes; the mint instruction fails if the required attestation is absent or if the attesting verifier has been slashed below the reputation threshold. |
| **No double counting (CCP 8)** | Retirement is an irreversible on-chain state transition. A retired credit cannot be transferred or used in a second retirement. The registry contract rejects any instruction that attempts to operate on a retired credit. |

CCPs 1, 3, 4, 7, 9, and 10 depend on off-chain governance and methodology design; CarbonChain records the standard and methodology reference on each credit to allow external verification against those frameworks.

---

## 6. Article 6 of the Paris Agreement and Corresponding Adjustments

### Background

The Paris Agreement, adopted in 2015, established a framework for global climate action built around Nationally Determined Contributions (NDCs) — each country's self-set emissions reduction pledge. Article 6 creates the rules for international carbon market cooperation, allowing countries and private actors to transfer emission reductions across borders.

### Article 6.2: Bilateral Cooperative Approaches

Article 6.2 governs government-to-government transfers of **Internationally Transferred Mitigation Outcomes (ITMOs)**. An ITMO is a unit of emission reduction that a host country transfers to a buyer country, which then uses it toward its own NDC target.

The key mechanism is the **corresponding adjustment**: when the host country transfers an ITMO, it must add back the equivalent emission reduction to its own national accounting ledger. Without this adjustment, both the host and buyer country could count the same tonne toward their respective NDCs — a form of double counting at the sovereign level.

Article 6.2 is bilateral: the terms, price, and conditions are negotiated directly between the two governments, often through dedicated agreements (sometimes called "carbon deals" or "ITMO agreements").

### Article 6.4: The New UNFCCC Crediting Mechanism

Article 6.4 establishes a centralized, UNFCCC-supervised crediting mechanism open to both government and private sector participation. It is the institutional successor to the CDM. Credits issued under Article 6.4 are called **Article 6.4 Emission Reductions (A6.4ERs)**.

Unlike Article 6.2, Article 6.4 operates through a multilateral Supervisory Body that approves methodologies, accredits verification bodies, and maintains the central registry. This provides more standardization than bilateral Article 6.2 deals.

Article 6.4 credits used for NDC compliance by a buyer country require a corresponding adjustment from the host country. Credits used only for voluntary purposes (not NDC compliance) may be issued without a corresponding adjustment, though this is an evolving area of the rules.

### Corresponding Adjustments and CarbonChain

CarbonChain tracks whether a corresponding adjustment has been applied through the `corresponding_adjustment` field on the credit record. When this flag is `true`, it indicates that the host country has formally applied the accounting adjustment in its national inventory, making the credit eligible for use toward NDC commitments or Article 6 compliance.

**Practical implications:**

- Credits with `corresponding_adjustment: true` are suitable for buyers with regulatory or high-integrity voluntary commitments that require Article 6 alignment.
- Credits with `corresponding_adjustment: false` can still be used for voluntary offsetting but do not carry Article 6 compliance status.
- The price premium for corresponding-adjustment credits reflects the additional sovereign-level process required and the higher confidence that the emission reduction is not counted twice at any level.
- CarbonChain does not verify corresponding adjustments autonomously; the flag is set by operators based on documentation from the host country's designated national authority (DNA) or the UNFCCC Article 6 database.

---

## 7. Glossary

**Additionality**
The principle that a carbon project's emission reductions or removals must be beyond what would have occurred in the absence of carbon credit revenue. A project fails the additionality test if it would have been implemented anyway for financial, regulatory, or other reasons.

**Article 6**
The section of the Paris Agreement that establishes rules for international carbon market cooperation, including bilateral transfers (Article 6.2) and the new UNFCCC crediting mechanism (Article 6.4).

**Avoided emissions**
Emission reductions achieved by preventing emissions that would otherwise have occurred, rather than by removing existing CO₂ from the atmosphere. Cookstoves, renewable energy, and REDD+ projects generate avoided emission credits.

**Buffer pool**
A reserve of carbon credits set aside at issuance to cover potential reversals of sequestration. If a project's stored carbon is subsequently released (e.g., through wildfire), credits are cancelled from the buffer pool rather than from buyers' accounts.

**Carbon credit**
A tradeable certificate representing the verified removal or avoidance of one metric tonne of CO₂ equivalent. Credits are issued by recognized standards bodies after independent third-party verification.

**CDM (Clean Development Mechanism)**
The carbon crediting mechanism established under the Kyoto Protocol, supervised by the UNFCCC. CDM issued Certified Emission Reductions (CERs) for projects in developing countries. Its successor under the Paris Agreement is the Article 6.4 mechanism.

**CER (Certified Emission Reduction)**
The credit unit of the CDM. One CER equals one tonne CO₂e reduced or removed.

**Corresponding adjustment**
An accounting entry a host country makes to its national emissions inventory when it transfers an ITMO to another country, ensuring the same emission reduction is not counted toward both countries' NDCs. Required for Article 6 compliance.

**Double counting**
The erroneous attribution of a single emission reduction or removal to more than one party's climate account. It can occur at the project level (double issuance of credits), at the entity level (double claiming of the same credit), or at the sovereign level (both host and buyer country counting the same ITMO without a corresponding adjustment).

**GHG (Greenhouse Gas)**
Gases that trap heat in the atmosphere, driving climate change. The six main GHGs covered by the Kyoto Protocol and Paris Agreement are CO₂, CH₄ (methane), N₂O (nitrous oxide), HFCs, PFCs, and SF₆. Carbon markets denominate all quantities in CO₂ equivalent (CO₂e) using standardized global warming potentials.

**Gold Standard**
A carbon crediting standard governed by the Gold Standard Foundation (Geneva). Its credits — Verified Emission Reductions (VERs) — emphasize sustainable development co-benefits aligned with the UN SDGs.

**ICVCM (Integrity Council for the Voluntary Carbon Market)**
An independent governance body that sets threshold quality standards for voluntary carbon credits through its Core Carbon Principles (CCPs). ICVCM assesses whether crediting programs meet these standards.

**ITMO (Internationally Transferred Mitigation Outcome)**
A unit of emission reduction transferred between countries under Article 6.2 of the Paris Agreement, used toward the receiving country's NDC.

**Leakage**
The displacement of emissions from a project area to another area as a result of the project activity. For example, a forest protection project may push loggers to unprotected areas nearby. Methodologies require leakage to be measured and discounted before credits are issued.

**MRV (Measurement, Reporting and Verification)**
The process of quantifying emission reductions or removals (measurement), documenting them according to methodology rules (reporting), and having an accredited independent body confirm the results (verification). MRV is the evidentiary foundation of every carbon credit.

**NDC (Nationally Determined Contribution)**
A country's self-set climate target under the Paris Agreement, specifying how much it will reduce or limit its GHG emissions. NDCs are submitted to the UNFCCC every five years and are expected to increase in ambition over time.

**Permanence**
The requirement that carbon stored or avoided by a project remains stored or avoided over the long term. Reversals (e.g., a forest fire releasing sequestered CO₂) undermine the credit's environmental claim; permanence risk is managed through buffer pools and monitoring obligations.

**Registry**
A database that records the issuance, ownership, transfer, and retirement of carbon credits. Registries prevent double counting by ensuring each credit exists in one place and can only be retired once. Major registries include the Verra Registry (VCS), Gold Standard Impact Registry, and the UNFCCC CDM Registry.

**Retirement**
The permanent cancellation of a carbon credit to represent an offset against reported emissions. Once retired, a credit cannot be resold or reused. Retirement is irreversible.

**REDD+ (Reducing Emissions from Deforestation and Forest Degradation)**
A framework for crediting the protection and sustainable management of forests in developing countries. The "+" refers to the role of conservation, sustainable forest management, and enhancement of forest carbon stocks. REDD+ credits are avoidance credits, not removal credits.

**Tonne CO₂e (tonne of carbon dioxide equivalent)**
The standard unit of carbon accounting. All GHG emissions and removals are expressed in terms of their CO₂ equivalent, calculated using 100-year global warming potentials (GWPs) published by the IPCC. One tonne CO₂e = 1,000 kg of CO₂ or the mass of another GHG that causes the same warming over 100 years.

**VCU (Verified Carbon Unit)**
The credit unit of the Verra Verified Carbon Standard. One VCU equals one tonne CO₂e reduced or removed.

**Verra**
A non-profit organization based in Washington, DC, that administers the Verified Carbon Standard (VCS) program and several other environmental standards. Verra maintains the Verra Registry and publishes VCS methodologies.

**Vintage**
The calendar year in which a carbon credit's underlying emission reduction or removal occurred. Vintage is distinct from the issuance date. Older vintages typically trade at a discount; many buyers require credits from the five most recent years.

**VVB (Validation and Verification Body)**
An independent organization accredited by a standards body to assess carbon projects. VVBs conduct validation (confirming that a project design meets methodology and standard requirements before implementation) and verification (confirming that monitoring data accurately reflects emission reductions or removals after a monitoring period).
