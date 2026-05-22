import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="centered" style={{ background: "transparent", border: "none", padding: 0 }}>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <SignUp />
      </div>
    </main>
  );
}
