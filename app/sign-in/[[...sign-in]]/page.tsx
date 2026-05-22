import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="centered" style={{ background: "transparent", border: "none", padding: 0 }}>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <SignIn />
      </div>
    </main>
  );
}
