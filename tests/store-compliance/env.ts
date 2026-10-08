// separate throwaway database so these tests can run alongside the other suites
process.env.TEST_DATABASE_URL ||= "postgresql://ua@127.0.0.1:55433/store_test";
