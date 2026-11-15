
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect } from "react";

// Creates coloured markers according to emergency urgency
function createIcon(urgency) {
  const colours = {
    Critical: "#b3261e",
    High: "#c5611a",
    Medium: "#a8860f",
    Low: "#4a7d56",
  };

  return L.divIcon({
    className: "custom-marker",
    html: `<div style="
      background:${colours[urgency] || "#64748b"};
      width:18px;
      height:18px;
      border:3px solid #fbfaf6;
      border-radius:50%;
      box-shadow:0 0 0 1.5px #1d1b17;
    "></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// Updates the map view when locations change
function MapUpdater({ requests }) {
  const map = useMap();

  useEffect(() => {
    const positions = requests
      .filter((request) => Number.isFinite(request.lat) && Number.isFinite(request.lng))
      .map((request) => [request.lat, request.lng]);

    if (positions.length > 0) {
      map.fitBounds(positions, { padding: [40, 40], maxZoom: 14 });
    }
  }, [requests, map]);

  return null;
}

export default function EmergencyMap({ requests = [] }) {
  const defaultPosition = [51.539, -0.142];

  return (
    <div className="emergency-map">
      <MapContainer
        center={defaultPosition}
        zoom={13}
        scrollWheelZoom={true}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <MapUpdater requests={requests} />

        {requests
          .filter((request) => Number.isFinite(request.lat) && Number.isFinite(request.lng))
          .map((request) => (
            <Marker
              key={request.id}
              position={[request.lat, request.lng]}
              icon={createIcon(request.urgency)}
            >
              <Popup>
                <strong>{request.name}</strong>
                <br />
                {request.category}
                <br />
                {request.location}
                <br />
                <strong>Urgency: {request.urgency}</strong>
                <br />
                Status: {request.status}
              </Popup>
            </Marker>
          ))}
      </MapContainer>
    </div>
  );
}
