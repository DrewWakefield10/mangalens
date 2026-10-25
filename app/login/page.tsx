import Link from "next/link";
export default function Login() {
  return (
    <main className="workspace narrow">
      <section className="panel empty">
        <h1>Your private reading space.</h1>
        <p>
          MangaLens currently uses temporary browser sessions. No account or
          password is needed. Projects remain accessible in this browser until
          the session or retention period expires.
        </p>
        <Link className="button primary" href="/projects">
          Open my library
        </Link>
      </section>
    </main>
  );
}
