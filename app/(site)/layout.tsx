export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <a href="/" className="font-display text-xl">Book your stay</a>
          <a href="/booking/find" className="text-sm text-primary underline">Find my booking</a>
        </div>
      </header>
      {children}
    </div>
  );
}
