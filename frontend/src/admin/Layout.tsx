import { NavLink, Outlet } from "react-router";

export default function Layout() {
  return (
    <div className="admin">
      <aside className="sidebar">
        <p className="brand">Feature Flags</p>
        <nav aria-label="Admin">
          <ul>
            <li><NavLink to="/admin/flags">Flags</NavLink></li>
            <li><NavLink to="/admin/health">System health</NavLink></li>
            <li><NavLink to="/admin/evaluations">Evaluations</NavLink></li>
          </ul>
        </nav>
        <a className="demo-link" href="/demo" target="_blank" rel="noreferrer">
          Open demo panel ↗
        </a>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
