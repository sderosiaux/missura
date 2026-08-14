import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt =
  "Missura — A blast radius of one mission.";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#FAF9F5",
          color: "#17181A",
          padding: 72,
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 26,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: "#55565C",
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 999,
              background: "#0E6B4A",
            }}
          />
          Missura
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 28,
          }}
        >
          <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>
            Same API. Smaller permissions. For every agent.
          </div>
          <div style={{ fontSize: 32, color: "#55565C", lineHeight: 1.4 }}>
            Keep the vendor SDK. Scope each agent run to one customer, for 30
            minutes.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            fontSize: 26,
          }}
        >
          <div
            style={{
              background: "#141514",
              color: "#E39287",
              padding: "12px 24px",
              borderRadius: 8,
            }}
          >
            - token: LINEAR_TOKEN
          </div>
          <div
            style={{
              background: "#141514",
              color: "#86D4B2",
              padding: "12px 24px",
              borderRadius: 8,
            }}
          >
            + token: MISSION_TOKEN
          </div>
        </div>
      </div>
    ),
    size,
  );
}
