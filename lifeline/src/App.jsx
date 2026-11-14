
import { useState } from "react";
import RequestForm from "./components/RequestForm";
import {
  Activity,
  AlertTriangle,
  Bell,
  ChevronRight,
  Heart,
  LayoutDashboard,
  MapPin,
  Package,
  Radio,
  Settings,
  Shield,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";

const initialRequests = [
  {
    id: "SOS-104",
    name: "Household A",
    category: "Water supplies",
    location: "Camden",
    people: 3,
    urgency: "Critical",
    status: "Open",
    time: "2 min ago",
  },
  {
    id: "SOS-103",
    name: "Household B",
    category: "Medical assistance",
    location: "Kentish Town",
    people: 2,
    urgency: "High",
    status: "Assigned",
    time: "8 min ago",
  },
  {
    id: "SOS-102",
    name: "Household C",
    category: "Shelter",
    location: "Chalk Farm",
    people: 4,
    urgency: "Medium",
    status: "Open",
    time: "14 min ago",
  },
  {
    id: "SOS-101",
    name: "Household D",
    category: "Food supplies",
    location: "Camden",
    people: 2,
    urgency: "Low",
    status: "Resolved",
    time: "21 min ago",
  },
];

function App() {
  const [requests, setRequests] = useState(initialRequests);
  const [networkOnline, setNetworkOnline] = useState(true);
  const [formOpen, setFormOpen] = useState(false);

  const openRequests = requests.filter(
    (request) => request.status === "Open"
  ).length;

  const handleNetworkToggle = () => {
    setNetworkOnline((previous) => !previous);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <Heart size={23} fill="white" />
          </div>
          <div>
            <h2>LIFELINE</h2>
            <span>COMMUNITY RESPONSE</span>
          </div>
        </div>

        <div className="sidebar-label">WORKSPACE</div>

        <nav className="navigation">
          <div className="nav-item active">
            <LayoutDashboard size={19} />
            Dashboard
          </div>
          <div className="nav-item">
            <AlertTriangle size={19} />
            Emergency requests
            <span className="nav-count">{openRequests}</span>
          </div>
          <div className="nav-item">
            <MapPin size={19} />
            Live map
          </div>
          <div className="nav-item">
            <Users size={19} />
            Volunteers
          </div>
          <div className="nav-item">
            <Package size={19} />
            Resources
          </div>
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-label">SYSTEM</div>
          <div className="nav-item">
            <Activity size={19} />
            Network activity
          </div>
          <div className="nav-item">
            <Settings size={19} />
            Settings
          </div>

          <div className="sidebar-profile">
            <div className="profile-avatar">LR</div>
            <div>
              <strong>Local response</strong>
              <span>Community node</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Workspace /</span>
            <strong> Dashboard</strong>
          </div>

          <div className="topbar-right">
            <span className={`network-pill ${networkOnline ? "online" : "offline"}`}>
              {networkOnline ? <Wifi size={15} /> : <WifiOff size={15} />}
              {networkOnline ? "Network online" : "Network disconnected"}
            </span>
            <button className="icon-button" aria-label="Notifications">
              <Bell size={19} />
            </button>
          </div>
        </header>

        <section className="dashboard">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">EMERGENCY COORDINATION SYSTEM</div>
              <h1>Community overview</h1>
              <p>Monitor requests, resources and neighbourhood activity.</p>
            </div>

            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <button
                className="network-button"
                onClick={() => setFormOpen(true)}
                style={{
                  background: "#263449",
                  borderColor: "#40516b",
                  color: "white",
                }}
              >
                + New request
              </button>

              <button
                className={`network-button ${networkOnline ? "" : "restore"}`}
                onClick={handleNetworkToggle}
              >
                <Radio size={17} />
                {networkOnline ? "Simulate network failure" : "Restore network"}
              </button>
            </div>
          </div>

          <div className="stats-grid">
            <StatCard
              icon={<AlertTriangle />}
              label="Open requests"
              value={openRequests}
              detail="Awaiting assistance"
              color="red"
            />
            <StatCard
              icon={<Users />}
              label="Available volunteers"
              value="07"
              detail="Ready to assist"
              color="blue"
            />
            <StatCard
              icon={<Package />}
              label="Resources matched"
              value="03"
              detail="Suggested matches"
              color="purple"
            />
            <StatCard
              icon={<Shield />}
              label="Requests resolved"
              value="12"
              detail="In this simulation"
              color="green"
            />
          </div>

          <div className="content-grid">
            <section className="panel requests-panel">
              <div className="panel-heading">
                <div>
                  <h2>Recent emergency requests</h2>
                  <p>Incoming community reports</p>
                </div>
                <button className="text-button">
                  View all <ChevronRight size={15} />
                </button>
              </div>

              <div className="request-list">
                {requests.map((request) => (
                  <div className="request-row" key={request.id}>
                    <div className="request-icon">
                      <AlertTriangle size={18} />
                    </div>

                    <div className="request-info">
                      <strong>{request.name}</strong>
                      <span>{request.category} · {request.location}</span>
                      <small>{request.id} · {request.time}</small>
                    </div>

                    <div className="request-meta">
                      <span className={`urgency ${request.urgency.toLowerCase()}`}>
                        {request.urgency}
                      </span>
                      <small>{request.status}</small>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel network-panel">
              <div className="panel-heading">
                <div>
                  <h2>Network health</h2>
                  <p>Neighbourhood connections</p>
                </div>
                <Activity size={20} />
              </div>

              <div className="network-visual">
                {["A", "B", "C", "D"].map((node) => (
                  <div className="node" key={node}>
                    <div className={`node-circle ${networkOnline ? "connected" : "isolated"}`}>
                      <Radio size={19} />
                    </div>
                    <span>Node {node}</span>
                    <small>{networkOnline ? "Connected" : "Offline"}</small>
                  </div>
                ))}
              </div>

              <div className="connection-summary">
                <span className={`status-dot ${networkOnline ? "green-dot" : "red-dot"}`} />
                <span>
                  {networkOnline
                    ? "All nodes communicating"
                    : "Network partition simulated"}
                </span>
              </div>
            </section>
          </div>

          <section className="panel map-placeholder">
            <div className="panel-heading">
              <div>
                <h2>Neighbourhood overview</h2>
                <p>Emergency coordination area</p>
              </div>
              <span className="map-label">
                <MapPin size={14} /> Camden, London
              </span>
            </div>

            <div className="map-content">
              <div className="map-message">
                <MapPin size={30} />
                <strong>Interactive response map</strong>
                <span>We'll integrate live incident markers here next.</span>
              </div>
            </div>
          </section>

          <footer className="footer">
            <span>LIFELINE © 2026</span>
            <span>Independent community coordination</span>
          </footer>
        </section>
      </main>

      {formOpen && (
        <RequestForm
          onClose={() => setFormOpen(false)}
          onSubmit={(newRequest) => {
            setRequests((previous) => [newRequest, ...previous]);
          }}
        />
      )}
    </div>
  );
}

function StatCard({ icon, label, value, detail, color }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${color}`}>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

export default App;
