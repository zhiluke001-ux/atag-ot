import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) return null;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email.toLowerCase() },
        });
        if (!user || !user.active) return null;

        const ok = await bcrypt.compare(credentials.password, user.password);
        if (!ok) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          grade: user.grade,
        } as any;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // When login happens, persist important fields into the token
      if (user) {
        (token as any).id = (user as any).id;
        (token as any).role = (user as any).role;
        (token as any).grade = (user as any).grade;
      }
      return token;
    },
    async session({ session, token }) {
      // Expose them on session.user
      (session.user as any).id = (token as any).id ?? token.sub; // sub is often userId too
      (session.user as any).role = (token as any).role;
      (session.user as any).grade = (token as any).grade;
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
};
