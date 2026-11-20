import { useEffect, useState } from 'react'

function App() {
  const [search, setSearch] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [user, setUser] = useState(null)
  const [isCheckingLogin, setIsCheckingLogin] = useState(true)

  const inventory = [
    {
      id: 1,
      sku: 'P001',
      name: 'Notebook',
      location: 'Main Storage',
      quantity: 20,
    },
    {
      id: 2,
      sku: 'P002',
      name: 'Pen',
      location: 'Main Storage',
      quantity: 50,
    },
  ]

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

      <p>Manage products and stock levels</p>

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
        </section>
      )}
    </div>
  )
}

export default App