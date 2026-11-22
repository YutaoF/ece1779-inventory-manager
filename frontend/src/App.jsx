import { useEffect, useState } from 'react'

// Main component
function App() {
  const [search, setSearch] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [user, setUser] = useState(null)
  const [isCheckingLogin, setIsCheckingLogin] = useState(true)
  const [receiveProductId, setReceiveProductId] = useState('1')
  const [receiveLocationId, setReceiveLocationId] = useState('1')
  const [receiveQuantity, setReceiveQuantity] = useState('')
  const [receiveMessage, setReceiveMessage] = useState('')
  const [isReceiving, setIsReceiving] = useState(false)
  const [issueProductId, setIssueProductId] = useState('1')
  const [issueLocationId, setIssueLocationId] = useState('1')
  const [issueQuantity, setIssueQuantity] = useState('')
  const [issueMessage, setIssueMessage] = useState('')
  const [isIssuing, setIsIssuing] = useState(false)
  const [transferProductId, setTransferProductId] = useState('1')
  const [sourceLocationId, setSourceLocationId] = useState('1')
  const [destinationLocationId, setDestinationLocationId] = useState('2')
  const [transferQuantity, setTransferQuantity] = useState('')
  const [transferMessage, setTransferMessage] = useState('')
  const [isTransferring, setIsTransferring] = useState(false)
  const [correctionProductId, setCorrectionProductId] = useState('1')
  const [correctionLocationId, setCorrectionLocationId] = useState('1')
  const [quantityDelta, setQuantityDelta] = useState('')
  const [correctionReason, setCorrectionReason] = useState('')
  const [correctionMessage, setCorrectionMessage] = useState('')
  const [isCorrecting, setIsCorrecting] = useState(false)
  const [inventory, setInventory] = useState([])
  const [inventoryMessage, setInventoryMessage] = useState('')
  const [inventoryVersion, setInventoryVersion] = useState(0)
  const [movements, setMovements] = useState([])
  const [historyMessage, setHistoryMessage] = useState('')
  const [thresholdInventoryId, setThresholdInventoryId] = useState('')
  const [thresholdValue, setThresholdValue] = useState('')
  const [thresholdMessage, setThresholdMessage] = useState('')
  const [isSavingThreshold, setIsSavingThreshold] = useState(false)
  const [dashboardView, setDashboardView] = useState('')
  const [locationFilter, setLocationFilter] = useState('')

  useEffect(() => {
    // Check login
    async function checkLogin() {
      try {
        const response = await fetch('/api/auth/me')

        if (response.ok) {
          const data = await response.json()
          setUser(data.user)
        } else if (response.status !== 401) {
          setLoginMessage('Unable to check login status.')
        }
      } catch {
        setLoginMessage('Unable to connect to the server.')
      } finally {
        setIsCheckingLogin(false)
      }
    }

    checkLogin()
  }, [])

  useEffect(() => {
    let cancelled = false

    // Load inventory
    async function loadInventory() {
      setInventory([])
      setInventoryMessage('Loading inventory...')

      try {
        const response = await fetch('/api/inventory')
        const data = await response.json()

        if (cancelled) return

        if (response.ok) {
          setInventory(data.inventory)
          setInventoryMessage('')
        } else if (response.status === 401) {
          setUser(null)
          setLoginMessage('Please log in again.')
          setInventoryMessage('')
        } else {
          setInventoryMessage(
            data.error?.message || 'Unable to load inventory.'
          )
        }
      } catch {
        if (!cancelled) {
          setInventoryMessage('Unable to load inventory.')
        }
      }
    }

    if (user) {
      loadInventory()
    }

    return () => {
      cancelled = true
    }
  }, [user, inventoryVersion])

  useEffect(() => {
    let cancelled = false

    // Load history
    async function loadHistory() {
      setMovements([])
      setHistoryMessage('Loading history...')

      try {
        const response = await fetch('/api/movements')
        const data = await response.json()

        if (cancelled) return

        if (response.ok) {
          setMovements(data.movements)
          setHistoryMessage('')
        } else if (response.status === 401) {
          setUser(null)
          setLoginMessage('Please log in again.')
          setHistoryMessage('')
        } else {
          setHistoryMessage(
            data.error?.message || 'Unable to load history.'
          )
        }
      } catch {
        if (!cancelled) {
          setHistoryMessage('Unable to load history.')
        }
      }
    }

    if (user) {
      loadHistory()
    }

    return () => {
      cancelled = true
    }
  }, [user, inventoryVersion])

  // User login
  async function handleLogin(event) {
    event.preventDefault()
    setLoginMessage('')
    setIsLoggingIn(true)

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      })

      const data = await response.json()

      if (response.ok) {
        setUser(data.user)
        setLoginMessage('')
        setPassword('')
      } else {
        setLoginMessage(data.error?.message || 'Login failed.')
      }
    } catch {
      setLoginMessage('Unable to connect to the server.')
    } finally {
      setIsLoggingIn(false)
    }
  }

  // User logout
  async function handleLogout() {
    setLoginMessage('')

    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
      })

      if (response.ok) {
        setUser(null)
        setPassword('')
      } else {
        setLoginMessage('Logout failed. Please try again.')
      }
    } catch {
      setLoginMessage('Unable to connect to the server.')
    }
  }

  // Receive stock
  async function handleReceive(event) {
    event.preventDefault()
    setReceiveMessage('')
    setIsReceiving(true)

    try {
      const response = await fetch('/api/stock-operations/receive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          productId: receiveProductId,
          locationId: receiveLocationId,
          quantity: Number(receiveQuantity),
        }),
      })

      const data = await response.json()

      if (response.ok) {
        setReceiveMessage(
          `Received ${data.quantityReceived} units. Balance after receipt: ${data.quantityAfter}.`
        )
        setReceiveQuantity('')
        setInventoryVersion((version) => version + 1)
      } else if (response.status === 401) {
        setUser(null)
        setLoginMessage('Your session has expired. Please log in again.')
        setReceiveMessage('')
      } else {
        setReceiveMessage(data.error?.message || 'Unable to receive stock.')
      }
    } catch {
      setReceiveMessage(
        'No confirmation received. Check the inventory before submitting again.'
      )
    } finally {
      setIsReceiving(false)
    }
  }

  // Issue stock
  async function handleIssue(event) {
    event.preventDefault()
    setIssueMessage('')
    setIsIssuing(true)

    try {
      const response = await fetch('/api/stock-operations/issue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          productId: issueProductId,
          locationId: issueLocationId,
          quantity: Number(issueQuantity),
        }),
      })

      const data = await response.json()

      if (response.ok) {
        setIssueMessage(
          `Issued ${data.quantityIssued} units. Balance after issue: ${data.quantityAfter}.`
        )
        setIssueQuantity('')
        setInventoryVersion((version) => version + 1)
      } else if (response.status === 401) {
        setUser(null)
        setLoginMessage('Your session has expired. Please log in again.')
        setIssueMessage('')
      } else {
        setIssueMessage(data.error?.message || 'Unable to issue stock.')
      }
    } catch {
      setIssueMessage(
        'No confirmation received. Check the inventory before submitting again.'
      )
    } finally {
      setIsIssuing(false)
    }
  }

  // Transfer stock
  async function handleTransfer(event) {
    event.preventDefault()
    setTransferMessage('')

    if (sourceLocationId === destinationLocationId) {
      setTransferMessage('Please select two different locations.')
      return
    }

    setIsTransferring(true)

    try {
      const response = await fetch('/api/stock-operations/transfer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          productId: transferProductId,
          sourceLocationId,
          destinationLocationId,
          quantity: Number(transferQuantity),
        }),
      })

      const data = await response.json()

      if (response.ok) {
        setTransferMessage(
          `Transferred ${data.quantityTransferred} units. Source balance: ${data.sourceQuantityAfter}. Destination balance: ${data.destinationQuantityAfter}.`
        )
        setTransferQuantity('')
        setInventoryVersion((version) => version + 1)
      } else if (response.status === 401) {
        setUser(null)
        setLoginMessage('Your session has expired. Please log in again.')
        setTransferMessage('')
      } else {
        setTransferMessage(data.error?.message || 'Unable to transfer stock.')
      }
    } catch {
      setTransferMessage(
        'No confirmation received. Check the inventory before submitting again.'
      )
    } finally {
      setIsTransferring(false)
    }
  }

  // Correct stock
  async function handleCorrection(event) {
    event.preventDefault()
    setCorrectionMessage('')

    const adjustment = Number(quantityDelta)
    const reason = correctionReason.trim()

    if (!Number.isInteger(adjustment) || adjustment === 0) {
      setCorrectionMessage('Please enter a non-zero integer')
      return
    }

    if (!reason) {
      setCorrectionMessage('Please enter a reason')
      return
    }

    setIsCorrecting(true)

    try {
      const response = await fetch('/api/stock-operations/correction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          productId: correctionProductId,
          locationId: correctionLocationId,
          quantityDelta: adjustment,
          reason,
        }),
      })

      const data = await response.json()

      if (response.ok) {
        setCorrectionMessage(
          `Correction applied. Balance after correction: ${data.quantityAfter}`
        )
        setQuantityDelta('')
        setCorrectionReason('')
        setInventoryVersion((version) => version + 1)
      } else if (response.status === 401) {
        setUser(null)
        setLoginMessage('Your session has expired. Please log in again.')
        setCorrectionMessage('')
      } else {
        setCorrectionMessage(
          data.error?.message || 'Unable to correct stock.'
        )
      }
    } catch {
      setCorrectionMessage(
        'No confirmation received. Check the inventory before submitting again.'
      )
    } finally {
      setIsCorrecting(false)
    }
  }

  // Select threshold
  function handleThresholdSelection(event) {
    const selectedId = event.target.value
    const selectedItem = inventory.find((item) => item.id === selectedId)

    setThresholdInventoryId(selectedId)
    setThresholdValue(
      selectedItem?.reorderThreshold == null
        ? ''
        : String(selectedItem.reorderThreshold)
    )
    setThresholdMessage('')
  }

  // Save threshold
  async function handleThresholdSubmit(event) {
    event.preventDefault()
    setThresholdMessage('')

    const selectedItem = inventory.find(
      (item) => item.id === thresholdInventoryId
    )

    if (!selectedItem) {
      setThresholdMessage('Please select a product and location.')
      return
    }

    const threshold =
      thresholdValue === '' ? null : Number(thresholdValue)

    if (
      threshold !== null &&
      (!Number.isInteger(threshold) ||
        threshold < 0 ||
        threshold > 2147483647)
    ) {
      setThresholdMessage('Enter a whole number from 0 to 2147483647.')
      return
    }

    setIsSavingThreshold(true)

    try {
      const response = await fetch(
        `/api/inventory/${selectedItem.productId}/${selectedItem.locationId}/threshold`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            reorderThreshold: threshold,
          }),
        }
      )

      const data = await response.json()

      if (response.ok) {
        setThresholdMessage(
          data.reorderThreshold === null
            ? 'Threshold cleared.'
            : `${selectedItem.location} - Threshold saved: ${selectedItem.name}, ${data.reorderThreshold} units.`
        )
        setInventoryVersion((version) => version + 1)
      } else if (response.status === 401) {
        setUser(null)
        setLoginMessage('Your session has expired. Please log in again.')
        setThresholdMessage('')
      } else {
        setThresholdMessage(
          data.error?.message || 'Unable to save threshold.'
        )
      }
    } catch {
      setThresholdMessage('Unable to confirm whether the threshold was saved.')
    } finally {
      setIsSavingThreshold(false)
    }
  }

  const activeInventory = inventory.filter(
    (item) => !item.productArchived && !item.locationArchived
  )

  const lowStockItems = activeInventory.filter(
    (item) => item.stockStatus === 'low'
  )

  const outOfStockItems = activeInventory.filter(
    (item) => item.stockStatus === 'out_of_stock'
  )

  const inventoryLocations = []

  // Collect locations
  for (const item of inventory) {
    const alreadyAdded = inventoryLocations.some(
      (location) => location.id === item.locationId
    )

    if (!alreadyAdded) {
      inventoryLocations.push({
        id: item.locationId,
        name: item.location,
      })
    }
  }
  return (
    <div>
      <header className="top-bar">
        <h1>Inventory Manager</h1>

        <div className="login-section">
          {isCheckingLogin ? (
            <span>Checking login...</span>
          ) : user ? (
            <div className="login-area">
              <span>
                {user.name} ({user.role})
              </span>

              <button type="button" onClick={handleLogout}>
                Logout
              </button>
            </div>
          ) : (
            <form className="login-area" onSubmit={handleLogin}>
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />

              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />

              <button type="submit" disabled={isLoggingIn}>
                {isLoggingIn ? 'Logging in...' : 'Login'}
              </button>
            </form>
          )}

          {loginMessage && (
            <p className="login-message" role="status">
              {loginMessage}
            </p>
          )}
        </div>
      </header>

      <main className="page-content">
        {!isCheckingLogin && !user && (
          <div className="login-notice">
            <p>Please log in first.</p>
          </div>
        )}

        {user && (
          <section>
            <h2>Stock Dashboard</h2>

            <div className="dashboard-summary">
              <button
                type="button"
                className="dashboard-card"
                aria-expanded={dashboardView === 'low'}
                onClick={() => {
                  if (dashboardView === 'low') {
                    setDashboardView('')
                  } else {
                    setDashboardView('low')
                  }
                }}
              >
                <h3>Low Stock</h3>
                <p>{lowStockItems.length}</p>
              </button>

              <button
                type="button"
                className="dashboard-card"
                aria-expanded={dashboardView === 'out_of_stock'}
                onClick={() => {
                  if (dashboardView === 'out_of_stock') {
                    setDashboardView('')
                  } else {
                    setDashboardView('out_of_stock')
                  }
                }}
              >
                <h3>Out of Stock</h3>
                <p>{outOfStockItems.length}</p>
              </button>
            </div>

            {dashboardView === 'low' && (
              <div>
                <h3>Low Stock Details</h3>

                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Product</th>
                      <th>Location</th>
                      <th>Quantity</th>
                      <th>Threshold</th>
                    </tr>
                  </thead>

                  <tbody>
                    {lowStockItems.map((item) => (
                      <tr key={item.id}>
                        <td>{item.sku}</td>
                        <td>{item.name}</td>
                        <td>{item.location}</td>
                        <td>{item.quantity}</td>
                        <td>{item.reorderThreshold}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {dashboardView === 'out_of_stock' && (
              <div>
                <h3>Out of Stock Details</h3>

                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Product</th>
                      <th>Location</th>
                      <th>Quantity</th>
                    </tr>
                  </thead>

                  <tbody>
                    {outOfStockItems.map((item) => (
                      <tr key={item.id}>
                        <td>{item.sku}</td>
                        <td>{item.name}</td>
                        <td>{item.location}</td>
                        <td>{item.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h2>Inventory</h2>
            <p role="status">{inventoryMessage}</p>

            <input
              type="text"
              placeholder="Search by product name or SKU"
              aria-label="Search by product name or SKU"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />

            <label
              htmlFor="inventory-location"
              className="location-filter-label"
            >
              Location
            </label>
            <select
              id="inventory-location"
              value={locationFilter}
              onChange={(event) => setLocationFilter(event.target.value)}
            >
              <option value="">All Locations</option>

              {inventoryLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>

            <table>
              <thead>
                <tr>
                  <th>Product number</th>
                  <th>Product name</th>
                  <th>Storage Location</th>
                  <th>Quantity</th>
                </tr>
              </thead>

              <tbody>
                {inventory
                  .filter((item) =>
                    item.name.toLowerCase().includes(search.toLowerCase()) ||
                    item.sku.toLowerCase().includes(search.toLowerCase())
                  )
                  .filter((item) =>
                    locationFilter === '' ||
                    item.locationId === locationFilter
                  )
                  .map((item) => (
                    <tr key={item.id}>
                      <td>{item.sku}</td>
                      <td>{item.name}</td>
                      <td>{item.location}</td>
                      <td>{item.quantity}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <h2>Receive Stock</h2>
            <form className="stock-form" onSubmit={handleReceive}>
              <label htmlFor="receive-product">Product</label>
              <select
                id="receive-product"
                value={receiveProductId}
                onChange={(event) => setReceiveProductId(event.target.value)}
              >
                <option value="1">A001 - iPhone</option>
                <option value="2">A002 - iPad</option>
                <option value="3">A003 - MacBook Air</option>
                <option value="4">A004 - AirPods</option>
              </select>

              <label htmlFor="receive-location">Location</label>
              <select
                id="receive-location"
                value={receiveLocationId}
                onChange={(event) => setReceiveLocationId(event.target.value)}
              >
                <option value="1">Main Warehouse</option>
                <option value="2">Toronto Store</option>
              </select>

              <label htmlFor="receive-quantity">Quantity</label>
              <input
                id="receive-quantity"
                type="number"
                min="1"
                max="2147483647"
                step="1"
                required
                value={receiveQuantity}
                onChange={(event) => setReceiveQuantity(event.target.value)}
              />

              <button type="submit" disabled={isReceiving}>
                {isReceiving ? 'Receiving...' : 'Receive'}
              </button>

              <p role="status">{receiveMessage}</p>
            </form>

            <h2>Issue Stock</h2>

            <form className="stock-form" onSubmit={handleIssue}>
              <label htmlFor="issue-product">Product</label>
              <select
                id="issue-product"
                value={issueProductId}
                onChange={(event) => setIssueProductId(event.target.value)}
              >
                <option value="1">A001 - iPhone</option>
                <option value="2">A002 - iPad</option>
                <option value="3">A003 - MacBook Air</option>
                <option value="4">A004 - AirPods</option>
              </select>

              <label htmlFor="issue-location">Location</label>
              <select
                id="issue-location"
                value={issueLocationId}
                onChange={(event) => setIssueLocationId(event.target.value)}
              >
                <option value="1">Main Warehouse</option>
                <option value="2">Toronto Store</option>
              </select>

              <label htmlFor="issue-quantity">Quantity</label>
              <input
                id="issue-quantity"
                type="number"
                min="1"
                max="2147483647"
                step="1"
                required
                value={issueQuantity}
                onChange={(event) => setIssueQuantity(event.target.value)}
              />

              <button type="submit" disabled={isIssuing}>
                {isIssuing ? 'Issuing...' : 'Issue'}
              </button>

              <p role="status">{issueMessage}</p>
            </form>

            <h2>Transfer Stock</h2>

            <form className="stock-form" onSubmit={handleTransfer}>
              <label htmlFor="transfer-product">Product</label>
              <select
                id="transfer-product"
                value={transferProductId}
                onChange={(event) => setTransferProductId(event.target.value)}
              >
                <option value="1">A001 - iPhone</option>
                <option value="2">A002 - iPad</option>
                <option value="3">A003 - MacBook Air</option>
                <option value="4">A004 - AirPods</option>
              </select>

              <label htmlFor="transfer-source">From</label>
              <select
                id="transfer-source"
                value={sourceLocationId}
                onChange={(event) => setSourceLocationId(event.target.value)}
              >
                <option value="1">Main Warehouse</option>
                <option value="2">Toronto Store</option>
              </select>

              <label htmlFor="transfer-destination">To</label>
              <select
                id="transfer-destination"
                value={destinationLocationId}
                onChange={(event) => setDestinationLocationId(event.target.value)}
              >
                <option value="1">Main Warehouse</option>
                <option value="2">Toronto Store</option>
              </select>

              <label htmlFor="transfer-quantity">Quantity</label>
              <input
                id="transfer-quantity"
                type="number"
                min="1"
                max="2147483647"
                step="1"
                required
                value={transferQuantity}
                onChange={(event) => setTransferQuantity(event.target.value)}
              />

              <button type="submit" disabled={isTransferring}>
                {isTransferring ? 'Transferring...' : 'Transfer'}
              </button>

              <p role="status">{transferMessage}</p>
            </form>

            {user.role === 'manager' && (
              <div>
                <h2>Stock Correction</h2>

                <form className="stock-form" onSubmit={handleCorrection}>
                  <label htmlFor="correction-product">Product</label>
                  <select
                    id="correction-product"
                    value={correctionProductId}
                    onChange={(event) => setCorrectionProductId(event.target.value)}
                  >
                    <option value="1">A001 - iPhone</option>
                    <option value="2">A002 - iPad</option>
                    <option value="3">A003 - MacBook Air</option>
                    <option value="4">A004 - AirPods</option>
                  </select>

                  <label htmlFor="correction-location">Location</label>
                  <select
                    id="correction-location"
                    value={correctionLocationId}
                    onChange={(event) => setCorrectionLocationId(event.target.value)}
                  >
                    <option value="1">Main Warehouse</option>
                    <option value="2">Toronto Store</option>
                  </select>

                  <label htmlFor="correction-delta">Adjustment (+/−)</label>
                  <input
                    id="correction-delta"
                    type="number"
                    min="-2147483648"
                    max="2147483647"
                    step="1"
                    required
                    value={quantityDelta}
                    onChange={(event) => setQuantityDelta(event.target.value)}
                  />

                  <label htmlFor="correction-reason">Reason</label>
                  <input
                    id="correction-reason"
                    type="text"
                    required
                    value={correctionReason}
                    onChange={(event) => setCorrectionReason(event.target.value)}
                  />

                  <button type="submit" disabled={isCorrecting}>
                    {isCorrecting ? 'Applying...' : 'Apply Correction'}
                  </button>

                  <p role="status">{correctionMessage}</p>
                </form>
              </div>
            )}

            {user.role === 'manager' && (
              <div>
                <h2>Reorder Threshold</h2>

                <form className="stock-form" onSubmit={handleThresholdSubmit}>
                  <label htmlFor="threshold-inventory">Inventory</label>
                  <select
                    id="threshold-inventory"
                    required
                    value={thresholdInventoryId}
                    onChange={handleThresholdSelection}
                  >
                    <option value="">Select product and location</option>

                    {inventory
                      .filter((item) => !item.productArchived && !item.locationArchived)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.sku} - {item.name} / {item.location}
                        </option>
                      ))}
                  </select>

                  <label htmlFor="threshold-value">Threshold</label>
                  <input
                    id="threshold-value"
                    type="number"
                    min="0"
                    max="2147483647"
                    step="1"
                    value={thresholdValue}
                    onChange={(event) => setThresholdValue(event.target.value)}
                  />

                  <button type="submit" disabled={isSavingThreshold}>
                    {isSavingThreshold ? 'Saving...' : 'Save Threshold'}
                  </button>

                  <p>Leave blank to clear the threshold.</p>
                  <p role="status">{thresholdMessage}</p>
                </form>
              </div>
            )}

            <h2>Movement History</h2>
            <p role="status">{historyMessage}</p>
            <div className="history-table">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Product</th>
                    <th>Location</th>
                    <th>Operation</th>
                    <th>Change</th>
                    <th>Balance After</th>
                    <th>User</th>
                    <th>Reason</th>
                  </tr>
                </thead>

                <tbody>
                  {movements.map((movement) => (
                    <tr key={movement.id}>
                      <td>{new Date(movement.createdAt).toLocaleString()}</td>
                      <td>
                        {movement.sku} - {movement.name}
                      </td>
                      <td>{movement.location}</td>
                      <td>{movement.operation}</td>
                      <td>
                        {movement.quantityDelta > 0 ? '+' : ''}
                        {movement.quantityDelta}
                      </td>
                      <td>{movement.quantityAfter ?? '—'}</td>
                      <td>{movement.actorName}</td>
                      <td>{movement.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
