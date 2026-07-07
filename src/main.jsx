import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

/* Catches any render crash platform-wide so the screen is never just black.
   Also prints the real component stack to the console — even in this minified
   build — which is the fast path to root-causing the next one, instead of
   guessing from a mangled stack trace with no component names. */
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    // eslint-disable-next-line no-console
    console.error("ShippingCloud crashed:", err && err.message, "\nComponent stack:", info && info.componentStack);
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#f4f2ee",fontFamily:"ui-sans-serif,system-ui,sans-serif",padding:"24px"}}>
          <div style={{maxWidth:420,background:"#fff",border:"1px solid #e7e5e4",borderRadius:12,padding:24,boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
            <div style={{fontWeight:700,fontSize:18,color:"#1c1917",marginBottom:8}}>Something broke on this screen</div>
            <div style={{fontSize:13,color:"#78716c",marginBottom:16,lineHeight:1.5}}>
              The app hit an error and stopped instead of showing a blank screen. Reloading usually fixes it — if it keeps happening on the same screen, open the browser console (F12 → Console) and send the red error text, it points straight to the cause.
            </div>
            <button onClick={() => window.location.reload()} style={{background:"#1c1917",color:"#fff",border:"none",borderRadius:8,padding:"10px 16px",fontSize:14,fontWeight:600,cursor:"pointer"}}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(<ErrorBoundary><App/></ErrorBoundary>);
