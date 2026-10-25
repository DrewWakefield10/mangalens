import Link from "next/link";
export default function NotFound() {
  return (
    <main className="workspace empty">
      <h1>This page got lost.</h1>
      <p>Return to your library to find the next chapter.</p>
      <Link className="button primary" href="/projects">
        My library
      </Link>
    </main>
  );
}
