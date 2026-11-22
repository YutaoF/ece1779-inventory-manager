# Inventory Manager Frontend

React + Vite frontend for our Cloud Inventory Manager.

## Run it locally

From the repo root:

```bash
cd frontend
npm install
npm run dev
```

Open the local URL printed in the terminal.

You'll also need the backend and database running. Check the [backend README](../backend/README.md) for setup and account creation.

## What's working now

- Login, logout, and checking the current session.
- Inventory search by product name or number.
- Filtering inventory by location.
- Low-stock and out-of-stock counts with details.
- Receiving, issuing, and transferring stock.
- Stock corrections with a required reason, available to managers only.
- Setting or clearing reorder thresholds, also available to managers only.
- Movement history
