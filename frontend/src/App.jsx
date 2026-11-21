import { useEffect, useState } from 'react'

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

  const inventory = []

  useEffect(() => {
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
            <h2>Inventory</h2>

            <input
              type="text"
              placeholder="Search by product name"
              aria-label="Search by product name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />

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
                    item.name.toLowerCase().includes(search.toLowerCase())
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
          </section>
        )}
      </main>
    </div>
  )
}

export default App