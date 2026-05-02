/* ================================================
   StockWarden — app.js  (MySQL backend version)
   Inventory Management System — All Application Logic
   ================================================

   ARCHITECTURE OVERVIEW
   ─────────────────────
   1. API         — fetch() wrappers replacing localStorage
   2. State       — Editing flags, sort state
   3. Navigation  — SPA page switching
   4. Utilities   — Helpers: status, badges, money format, date
   5. Toasts      — Notification system
   6. Modals      — Open / close helpers
   7. Products    — CRUD: add, edit, delete, save
   8. Adjustments — Stock-in / stock-out workflow
   9. Transactions— Direct transaction recording
  10. Categories  — CRUD
  11. Render*     — DOM rendering for each page
  12. Init        — Bootstrap on page load
   ================================================ */


/* ================================================
   1. API LAYER  (replaces localStorage DB object)
   ================================================ */

const API = {

  /* ---- Generic fetch helpers with 401 redirect ---- */
  async get(path) {
    const res = await fetch(path);
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async delete(path) {
    const res = await fetch(path, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  /* ---- Named endpoint shortcuts ---- */
  getProducts()           { return this.get('/api/products'); },
  getCategories()         { return this.get('/api/categories'); },
  getTransactions()       { return this.get('/api/transactions'); },
  getDashboard()          { return this.get('/api/dashboard'); },
  getReports()            { return this.get('/api/reports'); },
  getMe()                 { return this.get('/auth/me'); },
  getUsers()              { return this.get('/api/users'); },

  createProduct(data)     { return this.post('/api/products', data); },
  updateProduct(id, data) { return this.put(`/api/products/${id}`, data); },
  deleteProduct(id)       { return this.delete(`/api/products/${id}`); },

  createCategory(data)    { return this.post('/api/categories', data); },
  updateCategory(id, data){ return this.put(`/api/categories/${id}`, data); },
  deleteCategory(id)      { return this.delete(`/api/categories/${id}`); },

  recordTransaction(data) { return this.post('/api/transactions', data); },

  createUser(data)        { return this.post('/api/users', data); },
  updateUser(id, data)    { return this.put(`/api/users/${id}`, data); },
  deleteUser(id)          { return this.delete(`/api/users/${id}`); },
  changePassword(id, data){ return this.put(`/api/users/${id}/password`, data); },

  logout() {
    return fetch('/auth/logout', { method: 'POST' })
      .then(() => window.location.href = '/login');
  },
};


/* ================================================
   2. APPLICATION STATE
   ================================================ */

let editingId    = null;   // product ID currently being edited (null = adding new)
let editingCatId = null;   // category ID currently being edited
let adjustingId  = null;   // product ID for the stock-adjust modal
let sortCol      = 'id';   // active sort column for inventory table
let sortDir      = 1;      // 1 = ascending, -1 = descending

// In-memory cache — refreshed on every renderAll()
let _products     = [];
let _categories   = [];
let _transactions = [];


/* ================================================
   3. NAVIGATION  (SPA — show/hide page divs)
   ================================================ */

function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById('page-' + page).classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => {
    if (n.getAttribute('onclick') && n.getAttribute('onclick').includes(`'${page}'`)) {
      n.classList.add('active');
    }
  });

  const renderers = {
    dashboard:    renderDashboard,
    inventory:    renderTable,
    categories:   renderCats,
    transactions: renderTx,
    reports:      renderReports,
  };
  if (renderers[page]) renderers[page]();
}


/* ================================================
   4. UTILITIES
   ================================================ */

function getStatus(product) {
  if (product.quantity === 0)                        return 'out';
  if (product.quantity <= product.reorder_point)     return 'low';
  return 'in';
}

function stockBadge(product) {
  const s = getStatus(product);
  const labels = { in: 'In Stock', low: 'Low Stock', out: 'Out of Stock' };
  return `<span class="badge badge-${s}">${labels[s]}</span>`;
}

function stockBar(product) {
  const max    = Math.max(product.reorder_point * 3, product.quantity, 1);
  const pct    = Math.min(100, (product.quantity / max) * 100);
  const s      = getStatus(product);
  const colors = { in: 'var(--success)', low: 'var(--warn)', out: 'var(--danger)' };
  return `
    <div class="stock-bar-wrap">
      <div class="stock-bar-bg">
        <div class="stock-bar-fill" style="width:${pct}%;background:${colors[s]}"></div>
      </div>
    </div>`;
}

function fmtMoney(value) {
  return '$' + parseFloat(value || 0).toFixed(2);
}

function fmtDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getCatName(id) {
  const cat = _categories.find(c => c.id == id);
  return cat ? cat.name : '—';
}


/* ================================================
   5. TOAST NOTIFICATIONS
   ================================================ */

function toast(msg, type = '') {
  const container = document.getElementById('toast-container');
  const el        = document.createElement('div');
  el.className    = `toast ${type}`.trim();
  el.textContent  = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}


/* ================================================
   6. MODAL HELPERS
   ================================================ */

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

function populateCategorySelect(selectId, selectedId = '') {
  const sel = document.getElementById(selectId);
  sel.innerHTML = '<option value="">— None —</option>';
  _categories.forEach(cat => {
    const opt       = document.createElement('option');
    opt.value       = cat.id;
    opt.textContent = cat.name;
    if (cat.id == selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}


/* ================================================
   7. PRODUCTS — CRUD
   ================================================ */

function openAddModal() {
  editingId = null;
  document.getElementById('modal-title-text').textContent = 'Add Product';

  ['f-name', 'f-sku', 'f-supplier', 'f-location', 'f-desc'].forEach(id => {
    document.getElementById(id).value = '';
  });
  ['f-qty', 'f-price', 'f-cost'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-reorder').value = 10;

  populateCategorySelect('f-category');
  openModal('product-modal');
}

function openEditModal(id) {
  editingId = id;
  const product = _products.find(p => p.id == id);
  if (!product) return;

  document.getElementById('modal-title-text').textContent = 'Edit Product';
  document.getElementById('f-name').value     = product.name;
  document.getElementById('f-sku').value      = product.sku;
  document.getElementById('f-qty').value      = product.quantity;
  document.getElementById('f-reorder').value  = product.reorder_point;
  document.getElementById('f-price').value    = product.price;
  document.getElementById('f-cost').value     = product.cost;
  document.getElementById('f-supplier').value = product.supplier  || '';
  document.getElementById('f-location').value = product.location  || '';
  document.getElementById('f-desc').value     = product.description || '';

  populateCategorySelect('f-category', product.category_id);
  openModal('product-modal');
}

async function saveProduct() {
  const name = document.getElementById('f-name').value.trim();
  const sku  = document.getElementById('f-sku').value.trim();

  if (!name || !sku) {
    toast('Product name and SKU are required', 'error');
    return;
  }

  const data = {
    name,
    sku,
    category_id:   parseInt(document.getElementById('f-category').value) || null,
    quantity:      parseInt(document.getElementById('f-qty').value)      || 0,
    reorder_point: parseInt(document.getElementById('f-reorder').value)  || 10,
    price:         parseFloat(document.getElementById('f-price').value)  || 0,
    cost:          parseFloat(document.getElementById('f-cost').value)   || 0,
    supplier:      document.getElementById('f-supplier').value.trim(),
    location:      document.getElementById('f-location').value.trim(),
    description:   document.getElementById('f-desc').value.trim(),
  };

  try {
    if (editingId) {
      await API.updateProduct(editingId, data);
      toast(`"${name}" updated`);
    } else {
      await API.createProduct(data);
      toast(`"${name}" added to inventory`);
    }
    closeModal('product-modal');
    await renderAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteProduct(id) {
  const product = _products.find(p => p.id == id);
  if (!confirm(`Delete "${product.name}"?\nThis action cannot be undone.`)) return;

  try {
    await API.deleteProduct(id);
    toast(`"${product.name}" deleted`, 'warn');
    await renderAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}


/* ================================================
   8. STOCK ADJUSTMENT MODAL
   ================================================ */

function openAdjustModal(id) {
  adjustingId = id;
  const product = _products.find(p => p.id == id);

  document.getElementById('adj-product-name').textContent = product.name;
  document.getElementById('adj-current-qty').textContent  = product.quantity;
  document.getElementById('adj-qty').value  = 1;
  document.getElementById('adj-note').value = '';

  openModal('adjust-modal');
}

async function saveAdjustment() {
  const qty  = parseInt(document.getElementById('adj-qty').value);
  const type = document.getElementById('adj-type').value;
  const note = document.getElementById('adj-note').value.trim();

  if (!qty || qty < 1) {
    toast('Please enter a valid quantity (minimum 1)', 'error');
    return;
  }

  try {
    await API.recordTransaction({
      product_id: adjustingId,
      type,
      quantity: qty,
      note,
    });

    const product = _products.find(p => p.id == adjustingId);
    toast(`Stock updated — ${product.name}`);
    closeModal('adjust-modal');
    await renderAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}


/* ================================================
   9. DIRECT TRANSACTION RECORDING
   ================================================ */

function openTxModal() {
  const sel = document.getElementById('tx-product');
  sel.innerHTML = '';
  _products.forEach(p => {
    const opt       = document.createElement('option');
    opt.value       = p.id;
    opt.textContent = `${p.name} (${p.sku})`;
    sel.appendChild(opt);
  });
  document.getElementById('tx-qty').value  = 1;
  document.getElementById('tx-note').value = '';
  openModal('tx-modal');
}

async function saveTx() {
  const prodId = parseInt(document.getElementById('tx-product').value);
  const qty    = parseInt(document.getElementById('tx-qty').value);
  const type   = document.getElementById('tx-type').value;
  const note   = document.getElementById('tx-note').value.trim();

  if (!prodId || !qty || qty < 1) {
    toast('Please select a product and enter a valid quantity', 'error');
    return;
  }

  try {
    await API.recordTransaction({ product_id: prodId, type, quantity: qty, note });
    toast('Transaction recorded successfully');
    closeModal('tx-modal');
    await renderAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}


/* ================================================
   10. CATEGORIES — CRUD
   ================================================ */

function openCatModal(id = null) {
  editingCatId = id;
  document.getElementById('cat-modal-title').textContent = id ? 'Edit Category' : 'Add Category';

  if (id) {
    const cat = _categories.find(c => c.id == id);
    document.getElementById('cat-name').value = cat.name;
    document.getElementById('cat-desc').value = cat.description || '';
  } else {
    document.getElementById('cat-name').value = '';
    document.getElementById('cat-desc').value = '';
  }
  openModal('cat-modal');
}

async function saveCategory() {
  const name = document.getElementById('cat-name').value.trim();
  const desc = document.getElementById('cat-desc').value.trim();

  if (!name) {
    toast('Category name is required', 'error');
    return;
  }

  try {
    if (editingCatId) {
      await API.updateCategory(editingCatId, { name, description: desc });
      toast(`Category "${name}" updated`);
    } else {
      await API.createCategory({ name, description: desc });
      toast(`Category "${name}" created`);
    }
    closeModal('cat-modal');
    await renderAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteCategory(id) {
  const cat = _categories.find(c => c.id == id);
  if (!confirm(`Delete category "${cat.name}"?`)) return;

  try {
    await API.deleteCategory(id);
    toast(`Category "${cat.name}" deleted`, 'warn');
    await renderAll();
  } catch (err) {
    toast(err.message, 'error'); // server will return "Cannot delete — products assigned"
  }
}


/* ================================================
   11a. RENDER — Inventory Table
   ================================================ */

function setSortCol(col) {
  if (sortCol === col) {
    sortDir *= -1;
  } else {
    sortCol = col;
    sortDir = 1;
  }
  renderTable();
}

function renderTable() {
  const search       = document.getElementById('search-input').value.toLowerCase();
  const catFilter    = document.getElementById('filter-category').value;
  const statusFilter = document.getElementById('filter-status').value;

  // Map API stock_status to short codes used by getStatus()
  const statusMap = { in_stock: 'in', low_stock: 'low', out_of_stock: 'out' };

  let products = _products.filter(p => {
    const catName     = getCatName(p.category_id);
    const matchSearch = !search ||
      p.name.toLowerCase().includes(search) ||
      p.sku.toLowerCase().includes(search)  ||
      catName.toLowerCase().includes(search);
    const matchCat    = !catFilter    || p.category_id == catFilter;
    const shortStatus = statusMap[p.stock_status] || getStatus(p);
    const matchStatus = !statusFilter || shortStatus === statusFilter;
    return matchSearch && matchCat && matchStatus;
  });

  products.sort((a, b) => {
    let av = a[sortCol], bv = b[sortCol];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return -sortDir;
    if (av > bv) return  sortDir;
    return 0;
  });

  const tbody = document.getElementById('inventory-tbody');
  const empty = document.getElementById('table-empty');
  tbody.innerHTML = '';

  if (products.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  products.forEach(p => {
    const stockValue = (p.quantity * p.cost).toFixed(2);
    const tr         = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-id">#${p.id}</td>
      <td>
        <div class="td-name">${p.name}</div>
        <div class="td-sku">${p.sku}${p.location ? ' · ' + p.location : ''}</div>
      </td>
      <td>${getCatName(p.category_id)}</td>
      <td style="font-weight:700;font-size:1rem">${p.quantity}</td>
      <td>${stockBar(p)}</td>
      <td>${fmtMoney(p.price)}</td>
      <td>${fmtMoney(p.cost)}</td>
      <td style="color:var(--accent);font-weight:700">${fmtMoney(stockValue)}</td>
      <td>${stockBadge(p)}</td>
      <td>
        <div class="td-actions">
          <button class="btn btn-ghost"   onclick="openAdjustModal(${p.id})" title="Adjust stock">±</button>
          <button class="btn btn-ghost"   onclick="openEditModal(${p.id})"   title="Edit product">✎</button>
          <button class="btn btn-danger"  onclick="deleteProduct(${p.id})"   title="Delete product">✕</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}


/* ================================================
   11b. RENDER — Categories Table
   ================================================ */

function renderCats() {
  const tbody = document.getElementById('cat-tbody');
  const empty = document.getElementById('cat-empty');
  tbody.innerHTML = '';

  if (_categories.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  _categories.forEach(cat => {
    const productCount = _products.filter(p => p.category_id == cat.id).length;
    const tr           = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-id">#${cat.id}</td>
      <td style="font-weight:700">${cat.name}</td>
      <td style="color:var(--muted);font-size:0.75rem">${cat.description || '—'}</td>
      <td><span class="badge badge-in">${productCount}</span></td>
      <td>
        <div class="td-actions">
          <button class="btn btn-ghost"  onclick="openCatModal(${cat.id})">✎</button>
          <button class="btn btn-danger" onclick="deleteCategory(${cat.id})">✕</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}


/* ================================================
   11c. RENDER — Transactions Table
   ================================================ */

function renderTx() {
  const tbody = document.getElementById('tx-tbody');
  const empty = document.getElementById('tx-empty');
  tbody.innerHTML = '';

  if (_transactions.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const typeColors = {
    stock_in:   'var(--success)',
    stock_out:  'var(--danger)',
    adjustment: 'var(--warn)',
    return:     'var(--accent)',
  };

  _transactions.forEach(tx => {
    const delta = tx.type === 'stock_out' ? `−${tx.quantity}` : `+${tx.quantity}`;
    const color = typeColors[tx.type] || 'var(--text)';
    const tr    = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-size:0.7rem;color:var(--muted)">${fmtDate(tx.created_at)}</td>
      <td style="font-weight:700">${tx.product_name}</td>
      <td>
        <span class="badge" style="background:#111;color:${color};border:1px solid ${color}">
          ${tx.type.replace('_', ' ')}
        </span>
      </td>
      <td style="font-weight:700;color:${color}">${delta}</td>
      <td style="color:var(--muted);font-size:0.75rem">${tx.note || '—'}</td>`;
    tbody.appendChild(tr);
  });
}


/* ================================================
   11d. RENDER — Dashboard
   ================================================ */

async function renderDashboard() {
  try {
    const { stats, alerts, recentTransactions } = await API.getDashboard();

    document.getElementById('kpi-total').textContent = stats.total_products;
    document.getElementById('kpi-value').textContent = fmtMoney(stats.total_value);
    document.getElementById('kpi-low').textContent   = stats.low_count;
    document.getElementById('kpi-out').textContent   = stats.out_count;

    document.getElementById('top-total').textContent = stats.total_products;
    document.getElementById('top-value').textContent = fmtMoney(stats.total_value);
    document.getElementById('top-low').textContent   = stats.low_count;

    const badgeEl = document.getElementById('nav-badge-low');
    badgeEl.style.display = (stats.low_count + stats.out_count) > 0 ? '' : 'none';

    // Low-stock alert table
    const dashLowEl = document.getElementById('dash-low-table');
    if (alerts.length === 0) {
      dashLowEl.innerHTML = '<div class="empty-state"><p>All items are well-stocked ✓</p></div>';
    } else {
      dashLowEl.innerHTML = `
        <table>
          <thead><tr><th>Product</th><th>Qty</th><th>Status</th></tr></thead>
          <tbody>
            ${alerts.map(p => `
              <tr>
                <td style="font-weight:700">${p.name}</td>
                <td>${p.quantity}</td>
                <td>${stockBadge(p)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }

    // Recent transactions as activity feed
    const logEl = document.getElementById('activity-log');
    if (recentTransactions.length === 0) {
      logEl.innerHTML = '<div class="empty-state"><p>No recent activity.</p></div>';
    } else {
      const typeColors = {
        stock_in:   'var(--success)',
        stock_out:  'var(--danger)',
        adjustment: 'var(--warn)',
        return:     'var(--accent)',
      };
      logEl.innerHTML = recentTransactions.map(tx => `
        <div class="log-item">
          <div class="log-dot" style="background:${typeColors[tx.type] || 'var(--accent)'}"></div>
          <div class="log-text">${tx.type.replace('_', ' ')}: ${tx.product_name} ×${tx.quantity}</div>
          <div class="log-time">${fmtDate(tx.created_at)}</div>
        </div>`
      ).join('');
    }
  } catch (err) {
    console.error('Dashboard error:', err);
    toast('Failed to load dashboard', 'error');
  }
}


/* ================================================
   11e. RENDER — Reports
   ================================================ */

async function renderReports() {
  try {
    const { top5, byCat, txCount, catCount, avgStock } = await API.getReports();

    document.getElementById('rep-cats').textContent = catCount;
    document.getElementById('rep-txs').textContent  = txCount;
    document.getElementById('rep-avg').textContent  = avgStock || 0;

    document.getElementById('rep-top-tbody').innerHTML = top5.length
      ? top5.map(p => `
          <tr>
            <td style="font-weight:700">${p.name}</td>
            <td style="color:var(--accent)">${fmtMoney(p.stock_value)}</td>
          </tr>`).join('')
      : '<tr><td colspan="2" style="color:var(--muted);font-size:0.75rem;padding:16px">No data yet</td></tr>';

    document.getElementById('rep-cat-tbody').innerHTML = byCat.length
      ? byCat.map(c => `
          <tr>
            <td style="font-weight:700">${c.category_name}</td>
            <td>${c.product_count}</td>
            <td>${c.total_qty || 0}</td>
          </tr>`).join('')
      : '<tr><td colspan="3" style="color:var(--muted);font-size:0.75rem;padding:16px">No categories yet</td></tr>';
  } catch (err) {
    console.error('Reports error:', err);
    toast('Failed to load reports', 'error');
  }
}


/* ================================================
   11f. RENDER — Filter dropdowns & category chips
   ================================================ */

function renderFilterDropdowns() {
  const sel      = document.getElementById('filter-category');
  const savedVal = sel.value;
  sel.innerHTML  = '<option value="">All Categories</option>';
  _categories.forEach(cat => {
    const opt       = document.createElement('option');
    opt.value       = cat.id;
    opt.textContent = cat.name;
    if (cat.id == savedVal) opt.selected = true;
    sel.appendChild(opt);
  });

  const chips = document.getElementById('cat-chips');
  chips.innerHTML = `<button class="chip active" onclick="filterByChip(this, '')">All</button>`;
  _categories.forEach(cat => {
    const btn       = document.createElement('button');
    btn.className   = 'chip';
    btn.textContent = cat.name;
    btn.onclick     = function () { filterByChip(this, cat.id); };
    chips.appendChild(btn);
  });
}

function filterByChip(el, catId) {
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('filter-category').value = catId;
  renderTable();
}


/* ================================================
   11g. RENDER — Copy MySQL Schema to clipboard
   ================================================ */

function copySchema() {
  const text = document.getElementById('schema-code').innerText;
  navigator.clipboard.writeText(text)
    .then(() => toast('MySQL schema copied to clipboard!'))
    .catch(() => toast('Could not copy — please select and copy manually', 'error'));
}


/* ================================================
   12. RENDER ALL  — Fetch fresh data then repaint
   ================================================ */

async function renderAll() {
  try {
    [_products, _categories, _transactions] = await Promise.all([
      API.getProducts(),
      API.getCategories(),
      API.getTransactions(),
    ]);
  } catch (err) {
    console.error('renderAll fetch error:', err);
    toast('Could not load data from server', 'error');
    return;
  }

  renderFilterDropdowns();
  renderTable();
  renderCats();
  renderTx();
  renderDashboard();
  renderReports();
}


/* ================================================
   2b. CURRENT USER & ROLE
   ================================================ */

let currentUser = null;

function isAdmin()   { return currentUser && currentUser.role === 'admin'; }
function isManager() { return currentUser && (currentUser.role === 'admin' || currentUser.role === 'manager'); }
function isViewer()  { return currentUser && currentUser.role === 'viewer'; }

function applyRoleUI() {
  // Show/hide elements based on role
  // Viewers: hide all add/edit/delete/adjust buttons
  const canWrite = isManager();
  const canAdmin = isAdmin();

  document.querySelectorAll('.role-manager').forEach(el => {
    el.style.display = canWrite ? '' : 'none';
  });
  document.querySelectorAll('.role-admin').forEach(el => {
    el.style.display = canAdmin ? '' : 'none';
  });

  // Show users nav item for admin only
  const usersNav = document.getElementById('nav-users');
  if (usersNav) usersNav.style.display = canAdmin ? '' : 'none';

  // Show current user info in header
  const userInfo = document.getElementById('current-user-info');
  if (userInfo && currentUser) {
    userInfo.textContent = currentUser.username + ' · ' + currentUser.role;
  }
}


/* ================================================
   USERS PAGE (admin only)
   ================================================ */

let _users = [];

function renderUsers() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (_users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">No users found</td></tr>';
    return;
  }

  _users.forEach(u => {
    const isSelf = currentUser && u.id === currentUser.id;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:700">${u.username}${isSelf ? ' <span style="color:var(--accent);font-size:0.7rem">(you)</span>' : ''}</td>
      <td style="color:var(--muted);font-size:0.8rem">${u.email}</td>
      <td><span class="badge badge-${u.role === 'admin' ? 'in' : u.role === 'manager' ? 'low' : 'out'}">${u.role}</span></td>
      <td><span class="badge badge-${u.is_active ? 'in' : 'out'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <div class="td-actions">
          ${!isSelf ? `<button class="btn btn-ghost" onclick="openEditUserModal(${u.id})">✎</button>` : ''}
          ${!isSelf ? `<button class="btn btn-danger" onclick="deleteUser(${u.id})">✕</button>` : ''}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

function openAddUserModal() {
  document.getElementById('user-modal-title').textContent = 'Add User';
  document.getElementById('u-username').value  = '';
  document.getElementById('u-email').value     = '';
  document.getElementById('u-password').value  = '';
  document.getElementById('u-role').value      = 'viewer';
  document.getElementById('u-password-field').style.display = '';
  document.getElementById('edit-user-id').value = '';
  openModal('user-modal');
}

function openEditUserModal(id) {
  const user = _users.find(u => u.id === id);
  if (!user) return;
  document.getElementById('user-modal-title').textContent  = 'Edit User';
  document.getElementById('u-username').value  = user.username;
  document.getElementById('u-email').value     = user.email;
  document.getElementById('u-password').value  = '';
  document.getElementById('u-role').value      = user.role;
  document.getElementById('u-active').checked  = !!user.is_active;
  document.getElementById('u-password-field').style.display = 'none';
  document.getElementById('edit-user-id').value = id;
  openModal('user-modal');
}

async function saveUser() {
  const editId   = document.getElementById('edit-user-id').value;
  const username = document.getElementById('u-username').value.trim();
  const email    = document.getElementById('u-email').value.trim();
  const password = document.getElementById('u-password').value;
  const role     = document.getElementById('u-role').value;
  const isActive = document.getElementById('u-active').checked ? 1 : 0;

  if (!username || !email || !role) {
    toast('Username, email, and role are required', 'error');
    return;
  }

  try {
    if (editId) {
      await API.updateUser(editId, { role, is_active: isActive });
      toast(`User "${username}" updated`);
    } else {
      if (!password) { toast('Password is required for new users', 'error'); return; }
      await API.createUser({ username, email, password, role });
      toast(`User "${username}" created`);
    }
    closeModal('user-modal');
    _users = await API.getUsers();
    renderUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteUser(id) {
  const user = _users.find(u => u.id === id);
  if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
  try {
    await API.deleteUser(id);
    toast(`User "${user.username}" deleted`, 'warn');
    _users = await API.getUsers();
    renderUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}


/* ================================================
   INIT — Bootstrap the application
   ================================================ */

async function init() {
  try {
    currentUser = await API.getMe();
  } catch (err) {
    window.location.href = '/login';
    return;
  }

  applyRoleUI();

  if (isAdmin()) {
    _users = await API.getUsers().catch(() => []);
  }

  await renderAll();
  navigate('dashboard');
}

init();
