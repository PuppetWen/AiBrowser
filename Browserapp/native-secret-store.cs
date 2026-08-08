using System;
using System.Security.Cryptography;
using System.Text;

internal static class NativeSecretStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("AiBrowser.LocalSecret.v1");

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1 || (args[0] != "encrypt" && args[0] != "decrypt"))
            {
                Console.Error.WriteLine("usage: native-secret-store <encrypt|decrypt>");
                return 2;
            }

            string input = (Console.In.ReadToEnd() ?? String.Empty).Trim();
            if (input.Length == 0)
            {
                Console.Error.WriteLine("missing input");
                return 2;
            }

            byte[] bytes = Convert.FromBase64String(input);
            byte[] output = args[0] == "encrypt"
                ? ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser)
                : ProtectedData.Unprotect(bytes, Entropy, DataProtectionScope.CurrentUser);
            Console.Out.Write(Convert.ToBase64String(output));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": secret operation failed");
            return 1;
        }
    }
}
