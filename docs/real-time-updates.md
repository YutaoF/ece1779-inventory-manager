# Real-time inventory updates

If Pete receives 3 units on one replica, other users can see the new balance, dashboard status and movement history on another replica without refreshing the page. PostgreSQL stores the balances and history. Socket.IO and Redis tell browsers when to read them again.

## Follow a Receive click

1. Pete's browser sends the existing `POST /api/stock-operations/receive`. The stock service checks the user, locks the balance, writes the movement and commits.
2. The HTTP handler asks Socket.IO to publish one `inventory:changed` event. It carries no payload. The Redis adapter forwards the notification to the other app replicas. Each replica notifies its signed-in browsers.
3. React app receives the event and fetches `GET /api/inventory` and `GET /api/movements`. The inventory table, low-stock dashboard and history render the committed values. Mango can keep his current filters and open form.
4. React also fetches both lists on every socket connection. 

If Redis temporarily becomes unreachable, stock writes can still commit. When the Redis connections recover, the replicas trigger a refresh so browsers that stayed connected can catch up too.




| File | Change | What it does |
| --- | --- | --- |
| [backend/src/stock/router.js](../backend/src/stock/router.js) | Modified | Receives the four stock POST requests. For a Receive click it passes `receive` to the shared transaction, checks the returned `applied` flag, and calls `notifyAfterCommit` only for a new change. |
| [backend/src/inventory/notify-after-commit.js](../backend/src/inventory/notify-after-commit.js) | New | The stock and threshold handlers both call this helper after saving their changes. It invokes the app's publisher and logs notification errors so a successful database write still gets a successful HTTP response. |
| [backend/src/realtime.js](../backend/src/realtime.js) | New | Runs Socket.IO on each replica. It checks the login session when a browser connects, publishes change notices to the other replicas through Redis, and checks local sessions before sending `inventory:changed` to their browsers. It also handles socket expiry, logout, and Redis reconnection. |
| [frontend/src/App.jsx](../frontend/src/App.jsx) | Modified | Opens a socket when a user signs in. A change event or reconnection increments `inventoryVersion`, which makes React fetch inventory and movement history again. The dashboard uses that inventory. Previous rows stay visible during the fetch, and logout closes the socket and clears the user's view. |
| [backend/src/server.js](../backend/src/server.js) | Modified | Starts Express and Socket.IO on the same HTTP server and port. In production it requires `REDIS_URL`. It waits for real-time setup before listening and closes Socket.IO, Redis and the database pool on shutdown. |
| [backend/src/app.js](../backend/src/app.js) | Modified | Makes Express's existing session middleware available as `app.locals.sessionMiddleware`. Socket.IO uses the same middleware to read the browser's `inventory.sid` cookie when it connects at `/api/socket.io/`. |
| [backend/src/auth/router.js](../backend/src/auth/router.js) | Modified | When a session is destroyed on logout, or an existing signed-in session is replaced at login, it asks the real-time server to disconnect the sockets belonging to that old session. This includes tabs connected to another replica. |

## Deployment Integration:
+++++

