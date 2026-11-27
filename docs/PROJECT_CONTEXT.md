# FraudShield Project Context

## Overview
FraudShield is a real-time fraud detection engine for instant payments (UPI-style), designed for a 30-hour hackathon. The system scores every payment transaction in real time with an end-to-end latency budget of **under 100 ms**.

The engine combines:
1. **Rule-based checks** (basic goal: velocity, amount anomalies, device/IP switching).
2. **Graph-based fraud ring detection** (advanced goal: cycle detection, mule networks, shared device clusters).
3. **Machine learning scoring** (pre-trained tree-based models on payment features).

A companion React frontend is developed independently; therefore, the API contract is strictly defined and fixed.

## Latency & Architecture Guardrails
- **In-Memory Operation**: Everything resides in memory. There is no database, no disk I/O, and no blocking network I/O in the `/score` path.
- **Strict Budget**: `/score` must stay under 100 ms.
- **Asynchronous Heavy Computations**: Graph algorithms (cycle detection, community detection) and ML retraining are computationally heavy. They execute periodically in background tasks and update a shared in-memory dictionary.
- **Synchronous Scoring Path**: The `/score` endpoint only performs fast in-memory lookups into the shared dict and executes lightweight rule evaluations.

## API Contracts
### `Transaction` (Incoming Request)
- `txn_id` (str): Unique transaction identifier.
- `timestamp` (str): ISO-8601 UTC timestamp.
- `sender_id` (str): Account ID initiating payment.
- `receiver_id` (str): Account ID receiving payment.
- `amount` (float): Transaction amount.
- `device_id` (str): Unique device identifier.
- `ip` (str): IP address.
- `channel` (str): Payment channel (default: `"UPI"`).

### `Reason`
- `rule` (str): Code or identifier of the triggered rule.
- `detail` (str): Human-readable explanation.
- `weight` (int): Score contribution.

### `ScoredTransaction` (Response)
- `txn_id` (str): Original transaction ID.
- `timestamp` (str): Original timestamp.
- `sender_id` (str): Original sender ID.
- `receiver_id` (str): Original receiver ID.
- `amount` (float): Original amount.
- `risk_score` (int): Calculated risk between 0 and 100.
- `decision` (str): `ALLOW` (0–39), `REVIEW` (40–69), or `BLOCK` (70–100).
- `reasons` (list[Reason]): Breakdown of triggered fraud signals.
- `ring_id` (optional str): Identified fraud ring or cluster ID, if applicable.
- `latency_ms` (float): Total processing time in milliseconds.

## Simulator & Scenarios
The simulator (`backend/app/simulator.py`) generates realistic payment streams across 500 accounts (`ACC_0000` to `ACC_0399` honest, `ACC_0400` to `ACC_0499` fraud pool):
- `normal`: Typical consumer UPI payments with lognormal distribution (median ~665 INR).
- `velocity_attack`: A single fraud account rapidly sending 15 high-value transactions (4,800–4,999 INR) to distinct receivers.
- `ring_attack`: 5 colluding fraud accounts passing funds in a cycle (A -> B -> C -> D -> E -> A) across multiple laps, sharing a single device ID with amounts decreasing by ~2% per hop.
- `fanout_cashout`: Mule forwarding pattern where victim accounts pay multiple mule accounts, which then forward ~90% of funds to a central cash-out account.
- `FRAUD_TXN_IDS`: Global set tracking ground-truth fraudulent transactions.
