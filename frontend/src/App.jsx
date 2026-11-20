import { useState } from 'react'

function App() {
  const [search, setSearch] = useState('')
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

  return (
    <div>
      <h1>Inventory Manager</h1>
      <p>Manage products and stock</p>

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
          {inventory.filter((item) =>
              item.name.toLowerCase().includes(search.toLowerCase()))
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
    </div>
  )
}

export default App