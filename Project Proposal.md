# Project Proposal: Cloud Inventory Manager

**Team members:** [Name 1], [Name 2], [Name 3], [Name 4]

## 1. Motivation

Many small organizations, such as student clubs, research labs, makerspaces, small shops and food banks, track physical inventory with a shared spreadsheet. This works until several people update stock at the same time. Counts drift, nobody knows who removed what or why, and items run out before anyone notices.

We have two groups of users in mind. **Managers** decide what is stocked, where it is kept and when to reorder. **Staff or volunteers** receive and hand out items day to day. Both need to trust that the number on the screen matches the shelf.

Existing options sit at two extremes. Spreadsheets are free and familiar but have no concurrency control, no meaningful permissions and no reliable change history. Commercial inventory systems solve these problems but are usually too expensive or heavy for a group of a dozen people. We see room for a small, focused tool that keeps an accurate shared record, shows changes as they happen, and never loses its history.

The problem also fits the course well: inventory is stateful by nature, so concurrency, persistence and recovery are core requirements of the application itself.

## 2. Objectives, Architecture, and Key Features

### 2.1 Objectives

1. Provide a shared, accurate view of how much of each product is at each location.
2. Make every stock change traceable: who, when and why.
3. Keep stock correct when several users act at once, with no negative stock and no lost updates.
4. Run the system as a replicated, monitored service on DigitalOcean whose data survives restarts and redeployments.

### 2.2 Core Features

- **Accounts and roles.** Individual logins with a Manager or Staff role. Staff handle daily stock actions; Managers also manage products, locations, accounts, thresholds and corrections. Permissions are enforced on the backend.
- **Products and locations.** Products have a unique SKU, name, category and description, and stock is tracked per product per location. Products are archived, not deleted, so their history is kept.
- **Stock operations.** Receive, issue and transfer stock; Managers can also make corrections with a required reason. Operations that would make stock negative are rejected.
- **Movement history.** Every change is a new entry. Mistakes are fixed with a correction, not by editing the past.
- **Search and dashboard.** Filter by name, SKU, category, location and stock status, with a dashboard of low-stock and out-of-stock items.
- **Live updates.** Changes by one user appear for others without refreshing.

A CSV export is a nice-to-have if time allows.

### 2.3 Planned Architecture

![Planned architecture diagram](ARCHITECTURE_DIAGRAM_URL)

The system has four main parts:

- **Nginx gateway:** the public entry point, handling HTTPS and forwarding both normal requests and WebSocket connections.
- **Application service:** a Node.js/Express backend serving a small React frontend. It runs as multiple replicas and holds all business logic and permission checks.
- **PostgreSQL:** the single source of truth. Each stock operation runs in a transaction, so a transfer updates both locations and both history entries, or nothing at all.
- **Redis:** used only to pass "inventory changed" notifications between replicas. It stores no inventory data.

When stock changes, the server sends a small notification and clients re-fetch data from the API. This keeps the database as the only place quantities live, so a missed message cannot leave a client showing wrong numbers for long.

### 2.4 Use of Required Course Technologies

**Docker and Docker Compose.** The frontend and backend are built into one application image; PostgreSQL, Redis and Nginx run in their own containers. Locally, one Compose command starts the whole stack with a local database volume.

**PostgreSQL and persistent storage.** We will run PostgreSQL ourselves rather than use a managed database. Its data will live on a DigitalOcean Volume attached to one Droplet, with the database container placed on that node. Our main check is to replace the database container and confirm all data is still there.

**Deployment provider.** We chose DigitalOcean over Fly.io because Droplets, Volumes and the monitoring dashboards map directly onto course material, Swarm runs on plain Droplets without extra layers, and Spaces gives us a place for backups.

**Orchestration.** We plan to use Docker Swarm, starting with two Droplets (one manager, one worker) and at least two application replicas, relying on Swarm's load balancing and replacement of failed containers. We chose Swarm over Kubernetes because we are more comfortable with Compose, leaving more time for application logic and testing, at the cost of less exposure to the wider orchestration ecosystem.

**Monitoring and observability.** DigitalOcean's metrics agent will run on every Droplet, with dashboards and alerts for CPU, memory and disk. We will add health and readiness endpoints (readiness checks database access) and structured logs for requests and stock operations.
### 2.5 Advanced Features

We are committing to two advanced features and treating two more as stretch goals.

**Committed:**

1. **Real-time updates.** Socket.IO with a Redis adapter, so changes reach every connected user regardless of which replica they are on. Clients re-sync after reconnecting in case they missed a notification. Demo: two users on different replicas see the same change appear.
2. **Security enhancements.** Hashed passwords; login sessions stored in PostgreSQL so all replicas share them; role checks on every protected route and on WebSocket connections; HTTPS; production credentials supplied as Docker Swarm secrets; database and Redis kept off the public network.

**Stretch goals, in priority order:**

3. **Backup and recovery.** A scheduled `pg_dump` uploaded to a private Spaces bucket, plus a tested restore into a separate database.
4. **CI/CD.** GitHub Actions running tests and building the image on pull requests, with automated deployment if time allows.

Which stretch goals we complete depends on how the core work goes. We would rather finish two features properly than four partially.

### 2.6 Key Design Decisions and Trade-offs

- **History is append-only.** This makes it trustworthy and easier to reason about, at the cost of mistakes staying visible as correction entries.
- **Concurrency is handled in the database.** We plan to use transactions and row-level locks on inventory rows, so correctness does not depend on the number of replicas. We still need to test exactly how conflicts are reported to users.
- **The database is a single instance.** Replicating PostgreSQL is out of scope. The database node, gateway and Swarm manager are therefore single points of failure, and our high-availability claims are limited to the application tier.
- **Redis is the one extra service,** needed only because several replicas must share real-time notifications.

### 2.7 Scope and Feasibility

The core is a fairly standard web application. The real effort goes into correctness under concurrency, durable storage and a clean replicated deployment, not a large number of screens. We deliberately left out purchase orders, suppliers, barcode scanning, multi-organization support and analytics beyond the dashboard.

With four members and about four weeks, we believe the core features plus two advanced features are achievable, with the stretch goals using any extra time.

## 3. Project Plan and Team Responsibilities

This plan reflects our current intentions. Dates and ownership will likely shift as we learn more, especially once we start deploying. We will track tasks in GitHub Issues and revisit the plan at weekly check-ins.

### 3.1 Development Stages

| Period | Focus |
| --- | --- |
| Nov 2–9 | Repository setup, agree on schema and API, minimal app in Compose. Set up an early Swarm cluster so deployment issues show up early. |
| Nov 10–17 | Core features: auth, roles, products, locations, stock operations, history. Deploy to Swarm with a volume-backed database; basic monitoring. |
| Nov 18–24 | Real-time updates and security hardening. Concurrency and failure testing. Demo ready for the presentation. |
| Nov 25–Dec 5 | Stretch goals and bug fixes. Final testing, report, `ai-session.md` and video. |

### 3.2 Tentative Division of Work

All four members contributed to this proposal. For development, we split the work by system area so each member owns a coherent part from start to finish. This split is tentative: we will rebalance it at check-ins if one area turns out larger than expected, and each member also supports one other area so no part depends on a single person.

| Member | Owns | Supports |
| --- | --- | --- |
| [Name 1] | Database schema and migrations; stock operations (transactions, locking, transfers); concurrency and rollback tests | Backend API |
| [Name 2] | Backend API structure; authentication, sessions and role checks; security features (HTTPS, secrets, network exposure) | Deployment |
| [Name 3] | React frontend (inventory, history, dashboard, management pages); real-time updates on client and server | API testing |
| [Name 4] | Dockerfiles and Compose; Swarm cluster, volume and DigitalOcean setup; monitoring and alerts; backup and CI/CD stretch goals | Stock logic testing |

Shared work, such as end-to-end testing, the final report, `ai-session.md`, the presentation and the video demo, will be split evenly closer to each deadline.

### 3.3 Integration Approach

We will agree on the API and schema in week one so frontend and backend work can run in parallel. Everyone uses the same Compose setup, work is merged through reviewed pull requests, and we redeploy to the cluster weekly rather than only near the deadline.

### 3.4 Dependencies and Risks

- **Stock logic is a bottleneck.** Most features depend on it and the schema, so these need to stabilize early.
- **Real-time updates depend on deployment.** Redis and the gateway must be configured correctly across replicas, and we do not yet know how much work that will take.
- **Volume placement.** A volume attaches to one Droplet at a time, so the database is pinned to one node and the Swarm configuration must respect that.
- **Scope.** If we fall behind, we will drop stretch goals before compromising the core.

## 4. Initial Team Reasoning and AI-Assisted Exploration

### 4.1 Initial Team Reasoning

**Problem framing.** We started from the inventory idea in the course examples because it felt concrete and easy to demo. At first we saw it as "a shared list of items with quantities", essentially a CRUD app with logins, where the main need was ease of use and access from anywhere.

**Initial technical hypotheses.** We assumed a single stock number per product would be enough, and that real-time updates would just mean pushing new numbers to the browser. We leaned towards Docker Swarm because we were already comfortable with Compose.

**Open questions.** We were unsure whether deleting products or editing history should be allowed, how to stop two people from taking the same last item at once, how WebSockets behave with several replicas behind a load balancer, and how DigitalOcean Volumes interact with Swarm scheduling.

### 4.2 Exploration and Evaluation

Through discussion, course material and documentation, the problem started to look less like a list and more like a ledger: stock tracked per location, with every change recorded along with a reason. This led to our append-only history and transactional stock operations.

We used ChatGPT to organize our notes and expand the feature list into a structured draft, which we then reviewed as a team. Some suggestions were useful. For example, it pointed out that Socket.IO needs a shared adapter such as Redis once there is more than one replica, which we confirmed in the Socket.IO documentation before adopting.

Other parts were more ambitious than realistic, such as replay handling for retried requests and committing to four advanced features. We cut this to two committed features plus stretch goals, and kept Redis only with a polling fallback so it is not a hard dependency.

Compared with our initial thinking, the proposal puts far more weight on the correctness and durability of stock data and less on the number of features.
